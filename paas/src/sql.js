// Lire la sortie d'un client de base en ligne de commande.
// psql sait sortir du CSV, mysql du TSV : deux formats simples, deux analyseurs courts,
// et aucune bibliothèque de pilote à embarquer dans le plan de contrôle.

/** CSV (RFC 4180, celui de psql --csv) → tableau de lignes, chaque ligne un tableau de champs. */
export function parseCsv(text) {
  const rows = []; let row = []; let field = ''; let quoted = false; let started = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false; }
      else field += c;
      continue;
    }
    if (c === '"' && field === '') { quoted = true; started = true; continue; }
    if (c === ',') { row.push(field); field = ''; started = true; continue; }
    if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      if (started || field !== '' || row.length) { row.push(field); rows.push(row); }
      row = []; field = ''; started = false;
      continue;
    }
    field += c; started = true;
  }
  if (started || field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

/** TSV de `mysql --batch` : les tabulations, retours à la ligne et antislashs sont échappés. */
export function parseTsv(text) {
  const out = [];
  for (const line of text.split('\n')) {
    if (line === '' && out.length) continue;
    if (line === '') continue;
    out.push(line.split('\t').map((f) => (f === 'NULL' ? null : f.replace(/\\(.)/g, (_, c) => ({ t: '\t', n: '\n', r: '\r', 0: '\0' }[c] ?? c)))));
  }
  return out;
}

const LIMITE = 2000; // lignes renvoyées au navigateur : au-delà, on tronque et on le dit

/**
 * Sortie brute d'un client → { columns, rows, truncated } ou { message } pour un ordre
 * qui ne renvoie pas de table (CREATE, INSERT…).
 */
export function toTable(text, format) {
  const clean = String(text ?? '').replace(/^﻿/, '');
  if (!clean.trim()) return { columns: [], rows: [], truncated: false, message: 'Ordre exécuté.' };
  const grid = format === 'tsv' ? parseTsv(clean) : parseCsv(clean);
  if (!grid.length) return { columns: [], rows: [], truncated: false, message: 'Ordre exécuté.' };
  // psql imprime « INSERT 0 1 » ou « CREATE TABLE » : une seule cellule, sans virgule.
  if (grid.length === 1 && grid[0].length === 1 && !/^".*"$/.test(clean.trim())) {
    return { columns: [], rows: [], truncated: false, message: grid[0][0] };
  }
  const columns = grid[0];
  const body = grid.slice(1);
  return { columns, rows: body.slice(0, LIMITE), truncated: body.length > LIMITE, total: body.length };
}
