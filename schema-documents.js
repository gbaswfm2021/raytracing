import { loadSchemaDocuments } from '../../platform/js/services.js';
import { configureModelSchema } from '../../platform/model-rust/js/api.js';

const workspaceUrl = new URL('../../', import.meta.url);
const applicationUrl = new URL('./', import.meta.url);
let active;

function confined(url) {
  return url.origin === workspaceUrl.origin
    && (url.pathname.startsWith(applicationUrl.pathname)
      || url.pathname.startsWith(new URL('platform/', workspaceUrl).pathname));
}

export async function loadModelSchema(schemaUrl, applicationId) {
  if (applicationId !== 'raytracing') throw new Error('The registered application ID must be raytracing.');
  const root = new URL(schemaUrl, workspaceUrl);
  if (!root.pathname.startsWith(applicationUrl.pathname) || root.origin !== workspaceUrl.origin) {
    throw new Error('The Raytracing schema must remain inside its application folder.');
  }
  const sources = await loadSchemaDocuments(root, workspaceUrl);
  if (!sources.length || sources.some(source => !confined(source.url))) {
    throw new Error('Raytracing schema imports must stay inside the application or shared platform.');
  }
  const schema = sources[0].document;
  if (schema.properties?.application?.const !== applicationId) throw new Error('The schema application ID does not match its catalog entry.');
  configureModelSchema(schema, sources.slice(1).map(source => source.document));
  active = { schema, sources };
  return active;
}

export async function activateModelSchema(model, modelLocation) {
  const reference = model?.['x-fullmeta-schema'];
  if (typeof reference !== 'string' || !reference) throw new Error('The model does not select an application schema.');
  const schemaUrl = new URL(reference, modelLocation);
  if (schemaUrl.origin !== workspaceUrl.origin || !schemaUrl.pathname.startsWith(applicationUrl.pathname)) {
    throw new Error('The model must select the Raytracing schema inside its application folder.');
  }
  return loadModelSchema(schemaUrl, model.application);
}

export function activeModelSchema() {
  if (!active) throw new Error('The Raytracing schema has not been loaded.');
  return active;
}

