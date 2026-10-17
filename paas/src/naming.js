// Les noms que Rail donne aux choses. Un seul endroit, parce que le plan de
// contrôle, le déployeur et l'API doivent tomber d'accord au caractère près.
//
// L'environnement « production » n'ajoute rien au nom : un projet qui n'a jamais
// touché aux environnements garde exactement les adresses qu'il avait.
//
//   api-boutique.apps.exemple.com            production
//   api-boutique-preprod.apps.exemple.com    environnement « preprod »
//   api.boutique.internal                    réseau privé, production
//   api.boutique-preprod.internal            réseau privé, « preprod »

export const PRODUCTION = 'production';

export const volumeName = (serviceId) => `rail-vol-${serviceId}`;

/** Le suffixe d'environnement : rien en production, « -<env> » ailleurs. */
export const envSuffix = (envName) => (!envName || envName === PRODUCTION ? '' : `-${envName}`);

/** Le nom d'hôte public fourni par Rail pour un service. */
export const autoHost = ({ service, project, environment, domain }) =>
  `${service}-${project}${envSuffix(environment)}.${domain}`.toLowerCase();

/** Le nom d'hôte du service sur le réseau privé (alias Docker). */
export const privateHost = ({ service, project, environment }) =>
  `${service}.${project}${envSuffix(environment)}.internal`.toLowerCase();

/** Le nom du conteneur d'un déploiement. */
export const containerName = (serviceId, number) => `rail-${serviceId}-${number}`;
