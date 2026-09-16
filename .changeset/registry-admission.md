---
"@llm-ports/core": minor
---

A missing adapter no longer takes the whole registry down, and the registry can be configured with an object.

**An unregistered adapter is now dropped with a warning** instead of making the constructor throw. It is removed from every chain that named it, and the other providers keep working. Previously a deployment configured for several vendors but holding only some of their API keys served nothing at all. The constructor still throws when nothing usable is left. Set `strictConfig: true` for the previous behaviour.

**`RegistryOptions.config`** accepts a `RegistryConfig` object and takes precedence over `env`. Environment configuration is unchanged and remains the default. A provider alias is derived from an environment variable's name, which cannot contain `/`, `.` or capitals, so model ids containing them could not be named before. The object is copied on construction.

**`conservativeShouldFallback`** is now exported: the fallback policy an unconfigured registry actually applies, previously an unnamed internal function. The existing `defaultShouldFallback` is a broader table that applies only when passed explicitly.
