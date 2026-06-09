export function opencodeModel(model, defaultProviderID = null) {
  if (!model || typeof model !== "string") return undefined;
  const value = model.trim();
  if (!value) return undefined;

  const separator = value.indexOf("/");
  if (separator >= 0) {
    return {
      providerID: value.slice(0, separator),
      modelID: value.slice(separator + 1),
    };
  }

  if (!defaultProviderID) return undefined;
  return { providerID: defaultProviderID, modelID: value };
}

export function opencodeModelString(model, defaultProviderID = null) {
  const normalized = opencodeModel(model, defaultProviderID);
  if (!normalized) return model;
  return `${normalized.providerID}/${normalized.modelID}`;
}
