// Explicit SDK facade, not a Proxy over the parent's object: reflection must not
// expose backing credentials, provider collections or mutable configuration.
const READ = [
  "getProviders",
  "getProvider",
  "getModels",
  "getModel",
  "getAvailableSnapshot",
  "getError",
  "getRegisteredProviderConfig",
  "getRegisteredProviderIds",
  "getRegisteredNativeProvider",
  "getCompatibilityRequestConfig",
  "getProviderAuthStatus",
  "hasConfiguredAuth",
  "isUsingOAuth",
  "isUsingSubscription",
];
const ASYNC_READ = ["checkAuth", "getAvailable", "getAuth"];
const EXECUTE = [
  "stream",
  "complete",
  "streamSimple",
  "completeSimple",
  "streamDeferred",
  "fetchDeferred",
  "cancelDeferred",
];
const DENIED = ["setRuntimeApiKey", "removeRuntimeApiKey", "login", "logout"];
function copy(value, seen = new Map()) {
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return seen.get(value);
  const result = Array.isArray(value) ? [] : Object.create(null);
  seen.set(value, result);
  for (const key of Object.keys(value)) {
    if (DENIED.includes(key) && typeof value[key] === "function")
      result[key] = forbidden;
    else result[key] = copy(value[key], seen);
  }
  return result;
}
function forbidden() {
  throw new Error("Provider configuration and credentials are parent-owned");
}
export function providerView(runtime) {
  if (!runtime || typeof runtime.streamSimple !== "function")
    throw new Error("A compatible parent model runtime is required");
  const facade = Object.create(null);
  for (const key of READ)
    if (typeof runtime[key] === "function")
      facade[key] = (...args) => copy(runtime[key](...args));
  for (const key of ASYNC_READ)
    if (typeof runtime[key] === "function")
      facade[key] = (...args) => {
        const value = runtime[key](...args);
        return value?.then ? value.then((item) => copy(item)) : copy(value);
      };
  for (const key of EXECUTE)
    if (typeof runtime[key] === "function")
      facade[key] = runtime[key].bind(runtime);
  // Parent maintains catalog/auth refresh. Child extension reload must not refresh
  // or replace it. Streaming/auth calls still use coordinated parent operations.
  facade.refresh = async () => ({ refreshed: false, errors: new Map() });
  for (const key of [
    "registerProvider",
    "registerNativeProvider",
    "unregisterProvider",
  ])
    facade[key] = () => {};
  for (const key of DENIED) facade[key] = forbidden;
  return Object.freeze(facade);
}
