export const wholeSeconds = (value) => new Date(value).toISOString().replace(/\.\d{3}Z$/, 'Z');

export function normalizeFleetBuiltAt(fleet) {
  if (!fleet || !Array.isArray(fleet.factories)) return fleet;
  const factories = fleet.factories.map((factory) => {
    const value = factory?.image?.builtAt;
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(Date.parse(value))) return factory;
    return { ...factory, image: { ...factory.image, builtAt: wholeSeconds(value) } };
  });
  return { ...fleet, factories };
}
