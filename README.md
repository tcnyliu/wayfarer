# Wayfarer — backpacking route planner

An all-in-one trip planner that runs entirely in your browser — no backend,
no build step, no accounts.

## Run it

Double-click `index.html`, or serve it locally:

```sh
python3 -m http.server 8642
```

then open http://localhost:8642.

To start the app preloaded with a personal itinerary (without committing it),
create `js/trip.local.js` (gitignored) that sets `window.LOCAL_TRIP` to an
object shaped like `DEFAULT_TRIP` in `js/data.js`.

## What it does

- **Unlimited stops** — search any city, town, or landmark (OpenStreetMap
  geocoding) and it drops into your route. Drag cards to reorder.
- **Routing time** — every leg shows an estimated duration, distance, and
  suggested mode (train / bus / flight). Well-known legs (e.g. Amsterdam →
  Paris) use curated real-schedule times; everything else is estimated from
  distance. Each leg links to Rome2Rio / Google Flights for booking.
- **Route optimizer** — keeps your start and end fixed and reorders the middle
  to minimize distance, while treating your "arrive by" deadlines as hard
  constraints.
- **Deadlines** — set an "arrive by" date on any stop; the app flags the route
  if the schedule would miss it.
- **Nights budget** — the bar tracks allocated vs. available nights;
  Auto-balance distributes the difference.
- **Explore any stop** — live hostels, restaurants/cafés/bars, and
  sights/museums near each city (OpenStreetMap Overpass API), with one-click
  Hostelworld / Booking.com / Google Maps searches.
- **Itinerary view** — day-by-day timeline with dates, notes, and travel legs.
  Print-friendly (the Print button gives a clean paper itinerary).
- **Persistence** — everything saves to your browser automatically.
  Export/Import moves trips between devices as JSON files.

## Notes

- Travel times are planning estimates — confirm exact schedules on
  Omio/Trainline/airline sites when booking.
- POI data comes from OpenStreetMap's free public APIs; results are cached for
  a week. Occasional slowness or misses are normal — the Hostelworld/Maps
  links always work.
