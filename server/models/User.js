import mongoose from "mongoose";

const userSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    appUserId: { type: String, unique: true, sparse: true, trim: true },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    passwordHash: { type: String, required: true, select: false },
    role: { type: String, enum: ["super_admin", "pvpi_member"], default: "pvpi_member", index: true },
    centerName: { type: String, default: "", trim: true },
    pvpiOfficerNumber: { type: String, default: "", trim: true },
    approvalStatus: { type: String, enum: ["pending", "approved", "rejected"], default: "approved" }
  },
  { timestamps: true }
);

export default mongoose.models.User || mongoose.model("User", userSchema);
