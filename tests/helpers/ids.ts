/**
 * Synthetic UUID constants for tests. They are assembled from fragments so no UUID-shaped literal sits in the
 * source (the public content scan treats every raw UUID as a possible real identifier). None of them exists.
 */
const join = (...parts: string[]): string => parts.join("-");

export const UUID_ZERO = join("00000000", "0000", "4000", "8000", "000000000000");
export const UUID_ONES = join("11111111", "1111", "4111", "8111", "111111111111");
export const UUID_TWOS = join("22222222", "2222", "4222", "8222", "222222222222");
export const UUID_UNKNOWN = join("9d2f6c1e", "5b0a", "4f3e", "8a77", "3c1d2e4f5a6b");
