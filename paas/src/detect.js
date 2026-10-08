// Comment construire un dépôt : son Dockerfile s'il en a un, sinon un Dockerfile
// engendré d'après ce qu'on y trouve (Node, Python, Go, Java) — l'équivalent
// du « zéro configuration » de Railway. Un `Procfile` (ligne `web:`) fixe la commande de démarrage.
import fs from 'node:fs';
import path from 'node:path';

export class DetectError extends Error {}

const has = (dir, f) => fs.existsSync(path.join(dir, f));
const read = (dir, f) => fs.readFileSync(path.join(dir, f), 'utf8');
const sh = (cmd) => JSON.stringify(['sh', '-c', cmd]);

function procfileWeb(dir) {
  if (!has(dir, 'Procfile')) return null;
  const m = /^web:\s*(.+)$/m.exec(read(dir, 'Procfile'));
  return m ? m[1].trim() : null;
}

const DOCKERIGNORE = ['.git', 'node_modules', '__pycache__', '*.pyc', '.venv', 'target', 'build', '.env', '.env.*', '*.log', ''].join('\n');

function node(dir) {
  const pkg = JSON.parse(read(dir, 'package.json'));
  const major = /(\d{2})/.exec(pkg.engines?.node || '')?.[1];
  const image = `node:${major && +major >= 18 && +major <= 24 ? major : 22}-slim`;
  const pm = has(dir, 'pnpm-lock.yaml') ? 'pnpm' : has(dir, 'yarn.lock') ? 'yarn' : 'npm';
  const install = { pnpm: 'pnpm install --frozen-lockfile', yarn: 'yarn install --frozen-lockfile', npm: has(dir, 'package-lock.json') ? 'npm ci' : 'npm install' }[pm];
  const prune = { pnpm: 'pnpm prune --prod', yarn: 'yarn install --production --ignore-scripts --prefer-offline', npm: 'npm prune --omit=dev' }[pm];
  const lockfiles = ['package.json', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', '.npmrc'].filter((f) => has(dir, f)).join(' ');
  let start = procfileWeb(dir);
  if (!start && pkg.scripts?.start) start = `${pm} start`;
  if (!start && pkg.main) start = `node ${pkg.main}`;
  if (!start && has(dir, 'index.js')) start = 'node index.js';
  if (!start) throw new DetectError('Projet Node sans script « start » : ajoutez-en un dans package.json, un Procfile ou un Dockerfile.');
  return {
    language: 'node',
    dockerfile: [
      `FROM ${image}`,
      'WORKDIR /app',
      pm === 'npm' ? '' : 'RUN corepack enable',
      `COPY ${lockfiles} ./`,
      `RUN ${install}`,
      'COPY . .',
      pkg.scripts?.build ? `RUN ${pm} run build` : '',
      `RUN ${prune}`,
      'ENV NODE_ENV=production',
      'USER node',
      `CMD ${sh(start)}`,
    ].filter(Boolean).join('\n'),
  };
}

function python(dir) {
  const deps = has(dir, 'requirements.txt') ? 'COPY requirements.txt ./\nRUN pip install --no-cache-dir -r requirements.txt'
    : has(dir, 'pyproject.toml') ? null : '';
  let start = procfileWeb(dir);
  if (!start) {
    const entry = ['main.py', 'app.py', 'server.py', 'run.py'].find((f) => has(dir, f));
    if (entry) start = `python ${entry}`;
  }
  if (!start) throw new DetectError('Projet Python : aucun point d\'entrée (main.py/app.py) ni Procfile. Ajoutez un Procfile « web: … » ou un Dockerfile.');
  const pyver = /requires-python\s*=\s*"[^\d]*(3\.\d+)/.exec(has(dir, 'pyproject.toml') ? read(dir, 'pyproject.toml') : '')?.[1] || '3.12';
  return {
    language: 'python',
    dockerfile: [
      `FROM python:${pyver}-slim`,
      'ENV PYTHONUNBUFFERED=1 PIP_DISABLE_PIP_VERSION_CHECK=1',
      'WORKDIR /app',
      deps === null ? 'COPY . .\nRUN pip install --no-cache-dir .' : `${deps}\nCOPY . .`,
      'RUN useradd --create-home app && chown -R app /app',
      'USER app',
      `CMD ${sh(start)}`,
    ].filter(Boolean).join('\n'),
  };
}

function go(dir) {
  const ver = /^go\s+(\d+\.\d+)/m.exec(read(dir, 'go.mod'))?.[1] || '1.23';
  let target = '.';
  if (!fs.readdirSync(dir).some((f) => f.endsWith('.go')) && has(dir, 'cmd')) {
    const cmds = fs.readdirSync(path.join(dir, 'cmd'), { withFileTypes: true }).filter((d) => d.isDirectory());
    if (cmds.length === 1) target = `./cmd/${cmds[0].name}`;
    else throw new DetectError('Projet Go : plusieurs binaires dans cmd/ — ajoutez un Dockerfile.');
  }
  const start = procfileWeb(dir);
  return {
    language: 'go',
    dockerfile: [
      `FROM golang:${ver} AS build`,
      'WORKDIR /src',
      'COPY go.mod go.sum* ./',
      'RUN go mod download',
      'COPY . .',
      `RUN CGO_ENABLED=0 go build -o /out/app ${target}`,
      'FROM debian:bookworm-slim',
      'RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/* && useradd --create-home app',
      'COPY --from=build /out/app /usr/local/bin/app',
      'USER app',
      `CMD ${start ? sh(start) : JSON.stringify(['app'])}`,
    ].join('\n'),
  };
}

function java(dir) {
  const maven = has(dir, 'pom.xml');
  const text = read(dir, maven ? 'pom.xml' : has(dir, 'build.gradle.kts') ? 'build.gradle.kts' : 'build.gradle');
  const raw = +(/<java\.version>(\d+)|<maven\.compiler\.release>(\d+)|JavaVersion\.VERSION_(\d+)|languageVersion\s*(?:=|\.set\()\s*(?:JavaLanguageVersion\.of\()?(\d+)/.exec(text)?.slice(1).find(Boolean) || 21);
  const v = [8, 11, 17, 21, 25].find((x) => x >= raw) || 21;
  const buildCmd = maven
    ? `${has(dir, 'mvnw') ? 'chmod +x mvnw && ./mvnw' : 'mvn'} -B -q -DskipTests package`
    : `${has(dir, 'gradlew') ? 'chmod +x gradlew && ./gradlew' : 'gradle'} --no-daemon -x test build`;
  const jars = maven ? 'target' : 'build/libs';
  const baseBuild = maven ? (has(dir, 'mvnw') ? `eclipse-temurin:${v}-jdk` : `maven:3-eclipse-temurin-${v}`)
    : (has(dir, 'gradlew') ? `eclipse-temurin:${v}-jdk` : `gradle:8-jdk${v}`);
  const start = procfileWeb(dir) || 'exec java $JAVA_OPTS -Dserver.port=${PORT:-8080} -jar /app.jar';
  return {
    language: 'java',
    dockerfile: [
      `FROM ${baseBuild} AS build`,
      'WORKDIR /src',
      'COPY . .',
      `RUN ${buildCmd}`,
      `RUN cp "$(ls ${jars}/*.jar | grep -v -e '-plain.jar' -e 'sources.jar' | head -1)" /app.jar`,
      `FROM eclipse-temurin:${v}-jre`,
      'RUN useradd --create-home app',
      'COPY --from=build /app.jar /app.jar',
      'USER app',
      `CMD ${sh(start)}`,
    ].join('\n'),
  };
}

/** @returns {{kind:'dockerfile', dockerfile:string} | {kind:'generated', language:string, dockerfile:string, dockerignore:boolean}} */
export function detectBuild(contextDir, { dockerfilePath } = {}) {
  if (dockerfilePath) {
    const f = path.join(contextDir, dockerfilePath);
    if (!fs.existsSync(f)) throw new DetectError(`Dockerfile introuvable : ${dockerfilePath}`);
    return { kind: 'dockerfile', dockerfile: f };
  }
  if (has(contextDir, 'Dockerfile')) return { kind: 'dockerfile', dockerfile: path.join(contextDir, 'Dockerfile') };
  let g = null;
  if (has(contextDir, 'package.json')) g = node(contextDir);
  else if (has(contextDir, 'go.mod')) g = go(contextDir);
  else if (has(contextDir, 'pom.xml') || has(contextDir, 'build.gradle') || has(contextDir, 'build.gradle.kts')) g = java(contextDir);
  else if (has(contextDir, 'requirements.txt') || has(contextDir, 'pyproject.toml') || has(contextDir, 'main.py') || has(contextDir, 'app.py')) g = python(contextDir);
  if (!g) throw new DetectError('Langage non reconnu (Node, Python, Go, Java) et pas de Dockerfile à la racine du service.');
  return { kind: 'generated', ...g, dockerignore: !has(contextDir, '.dockerignore') };
}

/** Écrit le Dockerfile engendré (et un .dockerignore s'il manque) dans le contexte. */
export function materialize(contextDir, build) {
  if (build.kind === 'dockerfile') return build.dockerfile;
  const f = path.join(contextDir, '.rail.Dockerfile');
  fs.writeFileSync(f, `${build.dockerfile}\n`);
  if (build.dockerignore) fs.writeFileSync(path.join(contextDir, '.dockerignore'), DOCKERIGNORE);
  return f;
}
