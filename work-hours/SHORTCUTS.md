# Work Hours Log: Shortcuts setup

The page only reads `work-log.csv`. These Shortcuts on the iPhone write it. The workplace location lives only inside the two automations; the log holds dates and times, nothing else.

## Log format

```
date,time,event,source
2026-11-05,07:58,IN,auto
2026-11-05,12:03,OUT,auto
2026-11-05,12:47,IN,auto
2026-11-05,16:41,OUT,auto
2026-11-05,16:45,CONFIRM,manual
```

Date is `yyyy-MM-dd`, time is 24-hour `HH:mm`. The header line is optional. The page also accepts `7:58 AM` style times and reports lines it cannot read.

## One-time setup

1. In Files, under **On My iPhone > Shortcuts**, create `work-log.csv` containing just the header line `date,time,event,source`. Keep it under On My iPhone (not iCloud Drive) so the log stays off the cloud.
2. Settings > Privacy & Security > Location Services > Shortcuts: **Always**, with **Precise Location** on. Without this the triggers fire late or not at all.

## The shortcuts

| Name | How it runs | Appends |
|---|---|---|
| Work In | Automation: Arrive at the workplace, radius about 0.25 mi / 400 m, Run Immediately, Notify When Run on | `<date>,<time>,IN,auto` |
| Work Out | Automation: Leave the same place and radius, Run Immediately, Notify When Run on | `<date>,<time>,OUT,auto` |
| Lunch | Home Screen shortcut, for lunch taken inside the radius. Choose from Menu: "Leaving for lunch" / "Back from lunch" | `OUT,manual` / `IN,manual` |
| Confirm Day | Home Screen shortcut. Ask for Input (Date, default today) | `<chosen date>,<current time>,CONFIRM,manual` |

Each one is a Text action built from Format Date variables, for example `[Format Date: yyyy-MM-dd],[Format Date: HH:mm],IN,auto`, followed by **Append to Text File** `work-log.csv` with **Make New Line** on.

## First-run check

- Run Work In by hand once, open `work-log.csv` in Files and check the new line is on its own row and reads like `2026-11-05,07:58,IN,auto`. Watch for: `HH` (24-hour), not `hh`; `MM` (month) in the date and `mm` (minutes) in the time.
- Check that the file Append wrote to is the one you created, not a second copy in another folder.
- For Confirm Day, pick yesterday and check that the line carries yesterday's date.
- Open the page, tap Open work-log.csv, pick the file and check that the test lines show up. Delete them in Files afterwards.
- After the first real workday, check the automations fired: one IN in the morning, one OUT in the evening, and an OUT/IN pair around an off-site lunch.

## What the page does with the punches

- Paid time is each IN to the next OUT. Gaps between them are unpaid breaks; a break over 60 minutes is flagged, and one unbroken stretch of 6 hours or more is noted as "no lunch logged".
- A gap of 5 minutes or less (`BOUNCE_MAX` in `logic.js`) is treated as the phone bouncing on the edge of the radius: it counts as paid and is not shown as a break.
- An open IN on today counts as on the clock up to now. An open IN on an earlier day is flagged as a missing OUT and adds no time.
- Punches are grouped by calendar date, so overnight shifts are not handled.
- There is no editing in the page. Fix a mistake by editing the CSV in Files.
