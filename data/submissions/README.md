# Trails people sent in

See [docs/SUBMISSIONS.md](../../docs/SUBMISSIONS.md).

- `inbox/`: submission files as they arrived (GPX). The workflow "Check submitted trails" runs
  `scripts/verify_submission.py` on each and reports what passed.
- `verified/<region>/<name>.geojson`: trails that passed every check, cleaned, with what was checked. A trail here
  goes into its region's pack only once a maintainer has looked at it and filled in `"approved_by"` (and
  `"approved_on"`, and `"area"`: the park or forest it is in, spelled as OpenStreetMap spells it).

Nothing else in this folder is read by the pack builder.
