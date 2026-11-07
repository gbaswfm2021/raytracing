// Schema loader registered (by catalog default) for the raytrace application.
// The raytrace package reuses the platform's generic schema-project interpreter, which loads the
// schema itself, so this loader only records which schema URL is active.
let activeSchemaUrl = null;

export function activeModelSchemaUrl() { return activeSchemaUrl; }

export async function loadModelSchema(schemaUrl) {
  activeSchemaUrl = new URL(schemaUrl);
}

export async function activateModelSchema(model, modelLocation) {
  activeSchemaUrl = new URL(model["x-fullmeta-schema"], modelLocation);
}
