# Context-sensitive privacy

Version 0.5.1 on `feat/context-aware-privacy` applies the same local context checks to chat and
extracted document text, before Off/Light/AI writing-style processing. No additional model or
network request is needed for these checks.

| Text | Default result |
| --- | --- |
| DOB: 1991-03-14 | DOB: [DATE_1] |
| Card expires 04/28 | Card expires [DATE_1] |
| My MRI is on September 22 | My MRI is on [DATE_1] |
| Invoice date: 2026-11-30 | Unchanged |
| Deadline: November 30, 2026 | Unchanged |
| Compare Microsoft and Google | Unchanged |
| What is the weather in Paris? | Unchanged |
| My employer is Google | My employer is [ORG_1], when name detection finds Google |
| I live in Paris | I live in [LOCATION_1], when name detection finds Paris |

Birth, medical, marriage/death and credential expiry/issue cues make dates sensitive. Calendar
recognition covers common numeric/named-month dates, birth years and month/year card expiries.
Useful dates, such as deadlines, invoice/lease dates, general events and product expiries, are
kept. Nearby clauses, form labels (including labels above values), JSON keys and bounded
CSV/TSV/Markdown header lookup associate dates with their own fields.

Public company/place questions and common product names stay visible unless nearby language
links them to a personal relationship. Uncertain proper nouns, people, direct contact details,
addresses, card/account identifiers, SSNs and secrets retain protection. A nearby “account” or
“policy” alone no longer makes an ordinary balance or quantity an ID.

Version 0.5.1 fixes missed routing numbers when PDF extraction wraps “routing” and “number” onto
different lines. Explicit routing/ABA/RTN labels, licence/license plates, VINs and lease/contract IDs
have dedicated rules; recognized identifier fields also work in forms, JSON and table columns.
These detections stay protected despite adjacent amount/date/public-reference language and do not
depend on the name model. Labelled routing values do not need a valid checksum to be masked.
Street-address rules include a single-letter direction and wrapped city/unit details. Remembered
IDs match whole values rather than prefixes of longer IDs or dates.

Remembered values and repeated mentions are rechecked at each occurrence: a hidden DOB does not
force the same date to disappear from a later deadline, and a private city does not force it to
disappear from a separate weather question. Explicit **Always hide** entries bypass the context
exceptions; **Never hide** and disabled categories keep their existing precedence.

The exact stock Never hide list from 0.4.1 is migrated to context-sensitive product handling, so
“my employer Google” can be hidden. Customized Never hide lists are preserved, including any
company names in them. Remove a company from that list if it should use context checks.

These are bounded, English-language heuristics, not full semantic understanding. Ambiguous prose,
unusual formatting, missing labels and extracted spreadsheet serial dates can be misclassified.
Person-name detection still depends on the existing NER model; fallback warnings and document
review remain in place. Public-person biographies are not a new exception. This does not provide
a guarantee that every identifying fact is removed.

Verification covers mixed sensitive/useful dates, structured fields, expiry formats, public versus
personal references, direct identifiers, propagation, explicit overrides, settings migration and
cross-document vault reuse. The built-extension document regression checks real PDF extraction
and delivery of cleaned `.txt` copies with sensitive dates replaced and useful dates retained.
It also checks wrapped routing labels and vehicle/lease identifiers while preserving amounts,
notice periods and vehicle model years. A supplied PDF can be tested locally using the optional
`DOCUMENT_REGRESSION` fixture described in [DOCUMENTS.md](DOCUMENTS.md).
