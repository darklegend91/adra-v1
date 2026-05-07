import mongoose from "mongoose";

const reportSchema = new mongoose.Schema(
  {
    reportNumber: { type: String, required: true, unique: true, index: true },
    caseRecordId: { type: String, required: true, index: true },
    createdByUserId: { type: String, required: true, index: true },
    createdByRole: { type: String, enum: ["super_admin", "pvpi_member"], default: "pvpi_member", index: true },
    createdByCenter: { type: String, default: "", index: true },
    immutable: { type: Boolean, default: true },
    secureReviewToken: { type: String, required: true, select: false },
    secureReviewTokenHash: { type: String, required: true, index: true },
    secureReviewTokenPreview: { type: String, required: true },
    processingStatus: { type: String, enum: ["processed", "needs_ocr", "failed"], default: "processed", index: true },
    sourceHash: { type: String, required: true, index: true },
    sourceMetadata: { type: mongoose.Schema.Types.Mixed, default: {} },
    extractedFields: { type: mongoose.Schema.Types.Mixed, default: {} },
    unknownFields: { type: mongoose.Schema.Types.Mixed, default: {} },
    privacyFindings: { type: [mongoose.Schema.Types.Mixed], default: [] },
    scoreSnapshots: { type: [mongoose.Schema.Types.Mixed], default: [] },
    confidence: { type: mongoose.Schema.Types.Mixed, default: {} },
    medicineName: { type: String, default: "", index: true },
    adverseReaction: { type: String, default: "", index: true },
    gender: { type: String, default: "", index: true },
    ageBand: { type: String, default: "", index: true },
    weightBand: { type: String, default: "", index: true },
    seriousness: { type: String, default: "", index: true },
    outcome: { type: String, default: "", index: true },
    caseRelation: { type: String, enum: ["new", "duplicate", "followup"], default: "new", index: true },
    followupHistory: { type: [mongoose.Schema.Types.Mixed], default: [] },
    duplicateHistory: { type: [mongoose.Schema.Types.Mixed], default: [] },
    ragChunks: { type: [mongoose.Schema.Types.Mixed], default: [] }
  },
  { timestamps: true }
);

export default mongoose.models.Report || mongoose.model("Report", reportSchema);
