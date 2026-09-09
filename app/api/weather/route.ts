import { NextResponse } from "next/server";

// Enkel in-memory cache (per server-instans) - MET Locationforecast oppdateres
// uansett sjelden nok til at 30 minutter er mer enn ferskt nok, og MET sine
// egne bruksvilkår ber om at man ikke kaller API-et oftere enn nødvendig.
const CACHE_TTL_MS = 30 * 60 * 1000;
const cache = new Map<string, { fetchedAt: number; payload: any }>();

// MET krever en identifiserende User-Agent og avviser kall uten en gyldig en.
const USER_AGENT = "Misemetrics/1.0 kontakt@misemetrics.app";

// Frost (frost.met.no) er MET sitt ARKIV med faktisk OBSERVERTE (historiske)
// værdata fra værstasjoner - til forskjell fra Locationforecast, som kun er
// en fremover-prognose og ikke dekker dager som har passert. Krever en
// gratis, selvregistrert klient-ID (se frost.met.no) satt som miljøvariabel
// FROST_CLIENT_ID i Vercel. Uten den satt: fortsetter appen å virke akkurat
// som før, historiske dager viser bare "ikke tilgjengelig" som tidligere.
const FROST_CLIENT_ID = process.env.FROST_CLIENT_ID;

function symbolToEmoji(code: string): string {
  if (!code) return "🌡️";
  if (code.includes("thunder")) return "⛈️";
  if (code.includes("sleet")) return "🌨️";
  if (code.includes("snow")) return "❄️";
  if (code.includes("lightrain") || code.includes("rainshowers")) return "🌦️";
  if (code.includes("rain")) return "🌧️";
  if (code.includes("fog")) return "🌫️";
  if (code.includes("clearsky")) return code.includes("night") ? "🌙" : "☀️";
  if (code.includes("fair")) return "🌤️";
  if (code.includes("partlycloudy")) return "⛅";
  if (code.includes("cloudy")) return "☁️";
  return "🌡️";
}

function mapEntry(entry: any) {
  const symbolCode = entry?.data?.next_1_hours?.summary?.symbol_code || entry?.data?.next_6_hours?.summary?.symbol_code || "";
  return {
    time: entry.time,
    temperature: entry?.data?.instant?.details?.air_temperature ?? null,
    symbolCode,
    emoji: symbolToEmoji(symbolCode),
    precipitationMm: entry?.data?.next_1_hours?.details?.precipitation_amount ?? entry?.data?.next_6_hours?.details?.precipitation_amount ?? null,
  };
}

// Frost har INGEN værsymbol-taksonomi som Locationforecast (den er bygget for
// automatiske målestasjoner, ikke prognoser) - dette er derfor en grov
// tilnærming basert kun på temperatur+nedbør, IKKE like presis som det ekte
// prognose-ikonet. Værvarsel-widgeten viser ellers samme layout som før.
function frostEmoji(meanTemp: number | null, precipMm: number | null): string {
  if (precipMm == null) return "🌡️";
  if (precipMm > 0.2) return meanTemp != null && meanTemp <= 0 ? "❄️" : "🌧️";
  return "☀️";
}

// Henter FAKTISK observert døgnmiddel-temperatur og døgn-nedbør for én
// stasjon og én dato fra Frost. Returnerer null (ikke feil) hvis noe mangler
// - kalleren faller da tilbake til vanlig "ikke tilgjengelig"-visning.
async function fetchFrostDay(stationId: string, date: string) {
  if (!FROST_CLIENT_ID) return null;
  try {
    const url = `https://frost.met.no/observations/v0.jsonld?sources=${encodeURIComponent(stationId)}&referencetime=${date}&elements=${encodeURIComponent("mean(air_temperature P1D),sum(precipitation_amount P1D)")}`;
    const auth = Buffer.from(`${FROST_CLIENT_ID}:`).toString("base64");
    const res = await fetch(url, { headers: { Authorization: `Basic ${auth}` } });
    if (!res.ok) return null;
    const json = await res.json();
    const observations: any[] = json?.data?.[0]?.observations || [];
    const tempObs = observations.find((o) => o.elementId === "mean(air_temperature P1D)");
    const precipObs = observations.find((o) => o.elementId === "sum(precipitation_amount P1D)");
    const temperature = tempObs?.value != null ? Number(tempObs.value) : null;
    const precipitationMm = precipObs?.value != null ? Number(precipObs.value) : null;
    if (temperature == null && precipitationMm == null) return null;
    return {
      current: { temperature, symbolCode: "", emoji: frostEmoji(temperature, precipitationMm), precipitationMm },
      hourly: [] as any[],
      date,
      source: "frost",
      fetchedAt: new Date().toISOString(),
    };
  } catch {
    return null;
  }
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const lat = Number(searchParams.get("lat"));
  const lon = Number(searchParams.get("lon"));
  // Valgfri - MET returnerer uansett HELE tidsserien i ett kall (ikke ett
  // kall per dag); date brukes kun til å FILTRERE denne ene tidsserien og
  // til cache-nøkkelen. Uten date: samme "nå + neste 8 timer"-oppførsel
  // som før (bakoverkompatibelt for evt. andre fremtidige kallere).
  const date = searchParams.get("date");
  // Valgfri Frost-stasjons-ID (f.eks. "SN82290") for stedet - satt opp én
  // gang per sted i Admin. Brukes KUN for dager i fortiden, se under.
  const stationId = searchParams.get("stationId");
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return NextResponse.json({ error: "Mangler eller ugyldig lat/lon" }, { status: 400 });
  }

  // Avrundet nøkkel - unngår cache-miss på ubetydelige float-forskjeller,
  // samtidig som presisjonen (~100m) er mer enn god nok for et værvarsel.
  // date er med i nøkkelen slik at ulike dager caches uavhengig av hverandre.
  const key = `${lat.toFixed(3)},${lon.toFixed(3)},${date || "now"}`;
  const cached = cache.get(key);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return NextResponse.json(cached.payload);
  }

  // For dager i FORTIDEN prøves Frost (faktisk observert vær) først, siden
  // Locationforecast uansett kun dekker et fremover-vindu og vil returnere
  // "ikke tilgjengelig" for alt annet enn de aller nyeste dagene bakover.
  // Dagens dato/fremtidige dager går alltid via Locationforecast som før
  // (prognosen skal fortsette å oppdatere seg helt frem til dagen selv).
  const todayStr = new Date().toISOString().slice(0, 10);
  if (date && stationId && date < todayStr) {
    const frostPayload = await fetchFrostDay(stationId, date);
    if (frostPayload) {
      cache.set(key, { fetchedAt: Date.now(), payload: frostPayload });
      return NextResponse.json(frostPayload);
    }
    // Frost hadde ingenting å by på (f.eks. manglende FROST_CLIENT_ID, eller
    // stasjonen manglet data akkurat den dagen) - faller igjennom til vanlig
    // Locationforecast-forsøk under, som uansett gir et konsistent svar.
  }

  try {
    const res = await fetch(
      `https://api.met.no/weatherapi/locationforecast/2.0/compact?lat=${lat}&lon=${lon}`,
      { headers: { "User-Agent": USER_AGENT } }
    );
    if (!res.ok) {
      return NextResponse.json({ error: `MET svarte med status ${res.status}` }, { status: 502 });
    }
    const json = await res.json();
    const timeseries: any[] = json?.properties?.timeseries || [];
    if (!timeseries.length) {
      return NextResponse.json({ error: "Ingen værdata i svaret fra MET" }, { status: 502 });
    }

    let payload: any;

    if (date) {
      // Filtrer den ENE tidsserien til kun oppføringer for den forespurte
      // datoen (tidsstemplets dato-del før "T") - MET dekker kun ca. 9-10
      // dager fremover, så en for fjern (eller fortid-)dato gir ingen treff.
      const dayEntries = timeseries.filter((entry: any) => String(entry.time).slice(0, 10) === date);
      if (!dayEntries.length) {
        payload = { unavailable: true, date };
      } else {
        // Representativ temperatur/symbol for dagen: oppføringen nærmest kl. 12:00.
        let closest = dayEntries[0];
        let closestDiff = Infinity;
        for (const entry of dayEntries) {
          const hour = Number(String(entry.time).slice(11, 13));
          const diff = Math.abs(hour - 12);
          if (diff < closestDiff) { closestDiff = diff; closest = entry; }
        }
        const current = mapEntry(closest);
        // Time-for-time-oversikt BEGRENSET TIL DEN DAGEN (ikke resten av "nå"-dagen).
        const hourly = dayEntries.map(mapEntry);
        payload = { current, hourly, date, fetchedAt: new Date().toISOString() };
      }
    } else {
      const current = mapEntry(timeseries[0]);
      // MET leverer timesoppløsning for de nærmeste ~48 timene i compact-
      // produktet - de neste 8 oppføringene dekker dermed resten av dagen.
      const hourly = timeseries.slice(0, 8).map(mapEntry);
      payload = { current, hourly, fetchedAt: new Date().toISOString() };
    }

    cache.set(key, { fetchedAt: Date.now(), payload });
    return NextResponse.json(payload);
  } catch (e) {
    return NextResponse.json({ error: "Kunne ikke hente værdata" }, { status: 500 });
  }
}
