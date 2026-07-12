/* ============================================================
   Wayfarer — seed data
   Curated travel times for well-known European city pairs, plus
   the default trip the app loads on first run.
   ============================================================ */

/**
 * Curated door-to-door travel times (hours) for common legs.
 * Key: "cityA|cityB" with names normalized + alphabetically sorted.
 * mode: train | bus | flight | train+bus
 * Sources are typical direct schedules (ÖBB, DB, SNCF, Renfe, CP,
 * FlixBus, Eurostar) — always confirm exact times when booking.
 */
const CURATED_LEGS = {
  "venice|vienna":            { hours: 7.6,  mode: "train",     note: "ÖBB Railjet direct; Nightjet sleeper also runs (~11h)" },
  "budapest|vienna":          { hours: 2.6,  mode: "train",     note: "Railjet direct, hourly" },
  "budapest|prague":          { hours: 6.9,  mode: "train",     note: "EC direct; FlixBus similar" },
  "berlin|prague":            { hours: 4.4,  mode: "train",     note: "EC direct along the Elbe — scenic" },
  "amsterdam|berlin":         { hours: 6.3,  mode: "train",     note: "IC direct" },
  "amsterdam|paris":          { hours: 3.4,  mode: "train",     note: "Eurostar direct — book early for cheap fares" },
  "mont saint-michel|paris":  { hours: 4.0,  mode: "train+bus", note: "TGV to Rennes + Keolis bus shuttle" },
  "barcelona|mont saint-michel": { hours: 9.5, mode: "train",   note: "Bus to Rennes, TGV to Paris, TGV to Barcelona — long day; flying Nantes→Barcelona can be faster" },
  "barcelona|paris":          { hours: 6.7,  mode: "train",     note: "TGV/AVE direct" },
  "barcelona|porto":          { hours: 2.1,  mode: "flight",    note: "No practical rail link — Ryanair/Vueling direct ~2h" },
  "lisbon|porto":             { hours: 3.1,  mode: "train",     note: "CP Alfa Pendular / Intercidades" },
  "lagos|lisbon":             { hours: 4.0,  mode: "train",     note: "CP via Tunes; Rede Expressos bus similar" },
  "lagos|seville":            { hours: 3.5,  mode: "bus",       note: "ALSA direct coach" },
  "madrid|seville":           { hours: 2.7,  mode: "train",     note: "Renfe AVE high-speed" },
  "amsterdam|prague":         { hours: 10.5, mode: "train",     note: "Via Berlin; flight ~1.5h is faster" },
  "berlin|vienna":            { hours: 7.9,  mode: "train",     note: "Railjet/Nightjet direct" },
  "paris|prague":             { hours: 10.2, mode: "train",     note: "Via Frankfurt; flight is faster" },
  "barcelona|madrid":         { hours: 2.5,  mode: "train",     note: "Renfe AVE / Ouigo / Iryo — frequent" },
  "lisbon|madrid":            { hours: 1.2,  mode: "flight",    note: "No direct day train; sleeper or flight" },
  "lisbon|seville":           { hours: 4.5,  mode: "bus",       note: "ALSA / FlixBus direct coach" },
  "budapest|venice":          { hours: 9.0,  mode: "train",     note: "Via Vienna or direct EC seasonal" },
  "prague|vienna":            { hours: 4.0,  mode: "train",     note: "Railjet direct" },
  "paris|venice":             { hours: 10.5, mode: "train",     note: "TGV via Milan; Nightjet sleeper also possible" },
};

/**
 * Default trip — empty planner. Search above the stop list to add your
 * first destination.
 *
 * To ship a personal preloaded trip on your own machine without committing
 * it, create js/trip.local.js (gitignored) that sets `window.LOCAL_TRIP`
 * to an object with this same shape.
 */
const DEFAULT_TRIP = {
  version: 1,
  startDate: null,
  endDate: null,
  stops: [],
};
