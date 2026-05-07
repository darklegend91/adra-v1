import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";

const SALT_ROUNDS = 12;
const JWT_ISSUER = "adra-api";
const JWT_AUDIENCE = "adra-web";

export function normaliseEmail(email) {
  return String(email || "").trim().toLowerCase();
}

export async function hashPassword(password) {
  return bcrypt.hash(password, SALT_ROUNDS);
}

export async function verifyPassword(password, passwordHash) {
  if (!password || !passwordHash) return false;
  return bcrypt.compare(password, passwordHash);
}

export function signAuthToken(user, secret, expiresIn = "8h") {
  return jwt.sign(
    {
      sub: user.id,
      email: user.email,
      role: user.role,
      center: user.center || user.centerName || ""
    },
    secret,
    { audience: JWT_AUDIENCE, expiresIn, issuer: JWT_ISSUER }
  );
}

export function verifyAuthToken(token, secret) {
  return jwt.verify(token, secret, { audience: JWT_AUDIENCE, issuer: JWT_ISSUER });
}

export function publicUser(user) {
  return {
    id: String(user.id || user._id),
    name: user.name,
    email: user.email,
    role: user.role,
    center: user.center || user.centerName || "",
    approvalStatus: user.approvalStatus || "approved"
  };
}

export function validatePasswordStrength(password) {
  const value = String(password || "");
  if (value.length < 8) return "Password must be at least 8 characters.";
  if (!/[a-z]/.test(value)) return "Password must include a lowercase letter.";
  if (!/[A-Z]/.test(value)) return "Password must include an uppercase letter.";
  if (!/[0-9]/.test(value)) return "Password must include a number.";
  if (!/[^A-Za-z0-9]/.test(value)) return "Password must include a special character.";
  return "";
}
