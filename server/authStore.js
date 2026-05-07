import { connectMongo } from "./db.js";
import User from "./models/User.js";
import { hashPassword, normaliseEmail, publicUser } from "./authUtils.js";

async function ensureMongoReady() {
  await connectMongo();
}

export async function ensureMongoConnection() {
  await ensureMongoReady();
}

export async function findUserByEmail(email) {
  await ensureMongoReady();
  const normalised = normaliseEmail(email);
  const user = await User.findOne({ email: normalised }).select("+passwordHash");
  return user ? publicUserWithHash(user) : null;
}

export async function findUserById(id) {
  await ensureMongoReady();
  const conditions = [{ appUserId: id }];
  if (String(id).match(/^[0-9a-fA-F]{24}$/)) conditions.push({ _id: id });
  const user = await User.findOne({ $or: conditions }).select("+passwordHash");
  return user ? publicUserWithHash(user) : null;
}

export async function createUser({ name, email, password, role, centerName, pvpiOfficerNumber }) {
  await ensureMongoReady();
  const normalised = normaliseEmail(email);
  const passwordHash = await hashPassword(password);

  try {
    const created = await User.create({
      name,
      email: normalised,
      passwordHash,
      role,
      centerName,
      pvpiOfficerNumber,
      approvalStatus: "approved"
    });
    return publicUserWithHash(created);
  } catch (error) {
    if (error?.code === 11000) {
      const duplicate = new Error("An account with this email already exists.");
      duplicate.statusCode = 409;
      throw duplicate;
    }
    throw error;
  }
}

function publicUserWithHash(user) {
  return {
    ...publicUser(user),
    id: user.appUserId || String(user.id || user._id),
    passwordHash: user.passwordHash
  };
}
