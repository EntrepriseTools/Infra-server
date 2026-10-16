// Les références entre services, comme chez Railway :
//
//   DATABASE_URL = ${{ma-base.DATABASE_URL}}
//
// se résout au moment du déploiement, dans le projet du service. On ne copie donc
// jamais un mot de passe à la main : si la base change, un redéploiement suffit.
const PATTERN = String.raw`\$\{\{\s*([a-z0-9][a-z0-9-]{0,29})\.([A-Za-z_][A-Za-z0-9_]{0,127})\s*\}\}`;
const REF = new RegExp(PATTERN, 'g');

// Une instance neuve : un littéral global garde un `lastIndex` entre deux appels.
export const hasRef = (value) => new RegExp(PATTERN).test(String(value));

/**
 * Remplace les références dans un jeu de variables.
 * @param vars   {CLE: valeur}
 * @param lookup (nomDuService, cle) → valeur | undefined
 * @param onWarn (message) appelé pour chaque référence qui ne se résout pas (la valeur reste telle quelle)
 */
export function resolveRefs(vars, lookup, onWarn) {
  const out = {};
  for (const [key, raw] of Object.entries(vars)) {
    out[key] = String(raw).replace(REF, (whole, service, name) => {
      const value = lookup(service, name);
      if (value === undefined || value === null) {
        onWarn?.(`${key} : référence non résolue ${whole} (service « ${service} » ou variable « ${name} » absent)`);
        return whole;
      }
      return value;
    });
  }
  return out;
}
