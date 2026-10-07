"""
pdfplumber-based PDF text and table extraction.
Far more layout-aware than pdf-parse for complex multi-column forms
like CDSCO ADR Form 1.4 — especially the medication table (Section C).
"""
import base64
import io

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

router = APIRouter()

try:
    import pdfplumber  # type: ignore
    _PDFPLUMBER_AVAILABLE = True
except ImportError:
    _PDFPLUMBER_AVAILABLE = False


class PdfExtractRequest(BaseModel):
    pdf_b64: str
    pages: list[int] = []  # empty = all pages


@router.post("/extract-pdf")
def extract_pdf(body: PdfExtractRequest):
    if not _PDFPLUMBER_AVAILABLE:
        raise HTTPException(503, "pdfplumber not installed on this sidecar.")

    try:
        pdf_bytes = base64.b64decode(body.pdf_b64)
        with pdfplumber.open(io.BytesIO(pdf_bytes)) as pdf:
            target_pages = body.pages or list(range(len(pdf.pages)))
            all_text, all_tables, all_words = [], [], []

            for page_idx in target_pages:
                if page_idx >= len(pdf.pages):
                    continue
                page = pdf.pages[page_idx]

                # Layout-aware text extraction (respects columns)
                text = page.extract_text(x_tolerance=3, y_tolerance=3) or ""
                all_text.append(text)

                # Table extraction with cell boundaries
                for table in (page.extract_tables() or []):
                    if table:
                        all_tables.append({
                            "page": page_idx,
                            "rows": table,
                        })

                # Word-level positions for coordinate-based extraction
                for word in (page.extract_words() or []):
                    all_words.append({
                        "text": word["text"],
                        "page": page_idx,
                        "x0": round(word["x0"], 1),
                        "y0": round(word["top"], 1),
                        "x1": round(word["x1"], 1),
                        "y1": round(word["bottom"], 1),
                    })

        return {
            "text": "\n\n".join(filter(None, all_text)),
            "tables": all_tables,
            "words": all_words,
        }
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(500, str(exc)) from exc
