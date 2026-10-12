/**
 * Planted FAKE secrets for redaction tests. They are assembled at runtime from fragments so the
 * source tree never contains a literal that a secret scanner would flag. None of them is a real credential.
 */
const join = (...parts: string[]): string => parts.join("");

export const FAKE_AWS_KEY = join("AK", "IA", "ZZZZ0123456789AB");
export const FAKE_GITHUB_TOKEN = join("gh", "p_", "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8");
export const FAKE_STRIPE_KEY = join("sk", "_live_", "planted0123456789ABCDEFGH");
export const FAKE_SLACK_TOKEN = join("xo", "xb-", "0123456789-planted-token");
export const FAKE_API_KEY = join("sk", "-", "plantedPLANTEDplanted0123456789");
export const FAKE_GOOGLE_KEY = join("AI", "za", "SyPlantedPlantedPlanted0123456789ab");
export const FAKE_JWT = join("ey", "JhbGciOiJIUzI1NiJ9", ".", "eyJzdWIiOiJwbGFudGVkIn0", ".", "plantedSignature0123");
export const FAKE_BEARER = join("Bearer ", "plantedBearerToken0123456789abcdef");
export const FAKE_PRIVATE_KEY = join(
  "-----BEGIN RSA PRIV",
  "ATE KEY-----\nMIIplantedplantedplanted0123456789\nplantedplantedplanted\n-----END RSA PRIV",
  "ATE KEY-----",
);
export const FAKE_URL_WITH_PASSWORD = join("postgres", "://svc:", "plantedPass1234", "@localhost:5432/db");
export const FAKE_ASSIGNMENT = join("pass", "word=", "hunter2planted99");

export const ALL_FAKE_SECRETS: readonly string[] = [
  FAKE_AWS_KEY,
  FAKE_GITHUB_TOKEN,
  FAKE_STRIPE_KEY,
  FAKE_SLACK_TOKEN,
  FAKE_API_KEY,
  FAKE_GOOGLE_KEY,
  FAKE_JWT,
  FAKE_BEARER,
  FAKE_PRIVATE_KEY,
  FAKE_URL_WITH_PASSWORD,
  FAKE_ASSIGNMENT,
];

/** The portion of each fake that must never appear in output. */
export const SECRET_CORES: readonly string[] = [
  FAKE_AWS_KEY,
  FAKE_GITHUB_TOKEN,
  FAKE_STRIPE_KEY,
  FAKE_SLACK_TOKEN,
  FAKE_API_KEY,
  FAKE_GOOGLE_KEY,
  FAKE_JWT,
  "plantedBearerToken0123456789abcdef",
  "MIIplantedplantedplanted0123456789",
  "plantedPass1234",
  "hunter2planted99",
];

/**
 * Shapes added after review round 1 found them accepted and served unredacted. Each entry is
 * [name, text carrying the fake, the core that must never survive]. Fragments are joined at runtime.
 */
export const REVIEW_ROUND1_SHAPES: readonly (readonly [string, string, string])[] = [
  ["npm token", `owner ${join("np", "m_", "aB3dE6gH9jK2mN5pQ8sT1vX4yZ7bC0eF3hJ6")} end`, join("np", "m_", "aB3dE6gH9jK2mN5pQ8sT1vX4yZ7bC0eF3hJ6")],
  ["gitlab token", `x ${join("gl", "pat-", "aB3dE6gH9jK2mN5pQ8sT")}`, join("gl", "pat-", "aB3dE6gH9jK2mN5pQ8sT")],
  ["sendgrid key", `k=${join("S", "G.", "aB3dE6gH9jK2mN5pQ8sT1v", ".", "xY7bC0eF3hJ6kL9mN2pQ5sT8vX1yZ4aB7dE0gH3jK6m")}`, "aB3dE6gH9jK2mN5pQ8sT1v"],
  ["twilio api key", `sid ${join("S", "K", "0123456789abcdef0123456789abcdef")}`, "0123456789abcdef0123456789abcdef"],
  ["twilio account sid", `sid ${join("A", "C", "fedcba9876543210fedcba9876543210")}`, "fedcba9876543210fedcba9876543210"],
  ["azure account key", `${join("Account", "Key")}=${join("aB3dE6gH9jK2mN5pQ8sT1vX4yZ7bC0eF3hJ6kL9mN2pQ5sT8vX1yZ4aB7dE0g", "==")}`, "aB3dE6gH9jK2mN5pQ8sT1vX4yZ7bC0eF3hJ6kL9mN2pQ5sT8vX1yZ4aB7dE0g"],
  ["cookie header", `${join("Coo", "kie")}: ${join("session", "id=aB3dE6gH9jK2mN5pQ8; theme=dark")}`, "aB3dE6gH9jK2mN5pQ8"],
  ["short bearer", join("Bear", "er ", "abc123"), "abc123"],
  ["user-only url credential", `${join("https", "://", "tokenA1b2C3d4E5f6")}@example.test/x`, "tokenA1b2C3d4E5f6"],
  ["slack webhook", join("https", "://hooks.", "slack.com/services/", "T0123ABCD/B0123ABCD/aB3dE6gH9jK2mN5pQ8sT1vX4"), "aB3dE6gH9jK2mN5pQ8sT1vX4"],
  ["google oauth token", `t ${join("ya", "29.", "aB3dE6gH9jK2mN5pQ8sT1vX4yZ7bC0eF3hJ6")}`, "aB3dE6gH9jK2mN5pQ8sT1vX4yZ7bC0eF3hJ6"],
  ["huggingface token", `t ${join("h", "f_", "aB3dE6gH9jK2mN5pQ8sT1vX4yZ7bC0eF3h")}`, "aB3dE6gH9jK2mN5pQ8sT1vX4yZ7bC0eF3h"],
  ["aws secret access key assignment", `${join("aws_", "secret_", "access_key")} = ${join("wJalrXUtnFEMI", "K7MDENGbPxRfiCYEXAMPLEKEY01")}`, "wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEY01"],
  ["zero width split github token", `t ${join("g", "h", "​", "p_", "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8")}`, "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8"],
  ["fullwidth aws key", `t ${"ＡＫＩＡ" + "ＺＺＺＺ０１２３４５６７８９ＡＢ"}`, "ＺＺＺＺ０１２３４５６７８９ＡＢ"],
  ["word adjacent github pat", `t x${join("github", "_pat_", "aB3dE6gH9jK2mN5pQ8sT1vX4yZ7")}`, "aB3dE6gH9jK2mN5pQ8sT1vX4yZ7"],
  ["authorization digest header", `${join("Authorization", ": Digest ")}username="svc", response="aB3dE6gH9jK2mN5pQ8sT1vX4yZ7bC0eF"`, "aB3dE6gH9jK2mN5pQ8sT1vX4yZ7bC0eF"],
  ["json password with spaces", `{"${join("pass", "word")}": "correct horse battery staple9"}`, "correct horse battery staple9"],
  ["quoted assignment with spaces", `${join("pass", "word")} = "Tr0ub4dor and 3 more words"`, "Tr0ub4dor and 3 more words"],
  ["fullwidth assignment", "ｐａｓｓｗｏｒｄ＝ｐｌａｎｔｅｄＸ９９７７", "ｐｌａｎｔｅｄＸ９９７７"],
];

/** Benign look-alikes that must NOT be detected by the manifest validator. */
export const BENIGN_LOOKALIKES: readonly string[] = [
  "npm_config_cache",
  "svc.billing consumes contract.invoice",
  "Basic authentication method description",
  "ssh://git@example.test/repo",
  "https://example.test/path/to/thing",
  "sk-learn is a library",
  "token:prod-payments",
  "cred.payments.api-key",
  "the AC unit uses 32 hex digits sometimes",
  "manifests/token-service.yaml",
  "authorization: required",
];
