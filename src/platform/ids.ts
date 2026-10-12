const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export const isUuid = (value: unknown): value is string => typeof value === "string" && UUID.test(value);

/** Check-key and alias style identifiers (same character set as manifest node ids). */
export const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,254}$/;

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
export const hasControlChars = (value: string): boolean => CONTROL_CHARS.test(value);
