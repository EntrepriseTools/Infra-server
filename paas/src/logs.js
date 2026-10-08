// Journal d'un déploiement : un fichier par déploiement + diffusion en direct
// à ceux qui suivent (le tableau de bord, `rail logs -f`).
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';

export class LogHub {
  constructor(dir) { this.dir = dir; this.bus = new EventEmitter().setMaxListeners(0); this.open = new Set(); fs.mkdirSync(dir, { recursive: true }); }
  file(id) { return path.join(this.dir, `${id}.log`); }
  begin(id) { this.open.add(id); }
  append(id, text) {
    if (!text) return;
    fs.appendFileSync(this.file(id), text);
    this.bus.emit(id, text);
  }
  line(id, text) { this.append(id, `${text}\n`); }
  end(id) { this.open.delete(id); this.bus.emit(id, null); }
  isOpen(id) { return this.open.has(id); }
  read(id) { try { return fs.readFileSync(this.file(id), 'utf8'); } catch { return ''; } }
  // Rejoue l'existant puis suit jusqu'à la fin. Renvoie une fonction d'arrêt.
  follow(id, onData, onEnd) {
    const handler = (t) => { if (t === null) { this.bus.off(id, handler); onEnd(); } else onData(t); };
    this.bus.on(id, handler);
    onData(this.read(id));
    if (!this.isOpen(id)) { this.bus.off(id, handler); onEnd(); }
    return () => this.bus.off(id, handler);
  }
  remove(id) { fs.rmSync(this.file(id), { force: true }); }
}
