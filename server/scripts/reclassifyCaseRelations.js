import mongoose from "mongoose";
import { applyCaseLinkage, classifyCaseRelation } from "../ai/caseLinkage.js";
import { connectMongo } from "../db.js";
import Report from "../models/Report.js";

await connectMongo();

const reports = await Report.find({}).sort({ createdAt: 1, _id: 1 }).select("+secureReviewToken");
const priorReports = [];
let changed = 0;
const summary = { new: 0, duplicate: 0, followup: 0 };

for (const report of reports) {
  const current = report.toObject();
  const linkage = classifyCaseRelation(current, priorReports);
  summary[linkage.relation] += 1;

  const linked = applyCaseLinkage(current, linkage);
  const shouldUpdate = (
    report.caseRelation !== linked.caseRelation
    || JSON.stringify(report.duplicateHistory || []) !== JSON.stringify(linked.duplicateHistory || [])
    || JSON.stringify(report.followupHistory || []) !== JSON.stringify(linked.followupHistory || [])
    || JSON.stringify(report.unknownFields?.caseLinkage || {}) !== JSON.stringify(linked.unknownFields?.caseLinkage || {})
  );

  if (shouldUpdate) {
    await Report.updateOne(
      { _id: report._id },
      {
        $set: {
          caseRelation: linked.caseRelation,
          duplicateHistory: linked.duplicateHistory,
          followupHistory: linked.followupHistory,
          "unknownFields.caseLinkage": linked.unknownFields.caseLinkage
        }
      }
    );
    changed += 1;
  }

  priorReports.push(linked);
}

console.log(JSON.stringify({ scanned: reports.length, changed, summary }, null, 2));
await mongoose.disconnect();
