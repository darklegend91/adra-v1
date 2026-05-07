import mongoose from "mongoose";

const guidelineProfileSchema = new mongoose.Schema(
  {
    version: { type: String, required: true, unique: true, index: true },
    status: { type: String, enum: ["draft", "active", "archived"], default: "draft", index: true },
    requiredFields: { type: [String], default: [] },
    scoringWeights: { type: mongoose.Schema.Types.Mixed, default: {} },
    severityRules: { type: mongoose.Schema.Types.Mixed, default: {} },
    confidenceThresholds: { type: mongoose.Schema.Types.Mixed, default: {} },
    text: { type: String, default: "" },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null }
  },
  { timestamps: true }
);

export default mongoose.models.GuidelineProfile || mongoose.model("GuidelineProfile", guidelineProfileSchema);
