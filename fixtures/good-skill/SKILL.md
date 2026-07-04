---
name: processing-pdfs
description: Extracts text, tables, and form data from PDF files. Use when the user asks about PDFs, needs to extract content from documents, or mentions form filling.
---

# PDF Processing

## Quick start

Extract text from a PDF with pdfplumber:

```python
import pdfplumber

with pdfplumber.open("document.pdf") as pdf:
    for page in pdf.pages:
        text = page.extract_text()
        print(text)
```

## Form filling

For form filling, see [FORMS.md](FORMS.md).

## Error handling

```python
try:
    with pdfplumber.open(path) as pdf:
        return pdf.pages[0].extract_text()
except FileNotFoundError:
    print(f"File not found: {path}")
    return None
```

## Requirements

- `pdfplumber`: `pip install pdfplumber`
