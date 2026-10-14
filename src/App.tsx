import { useEffect, useRef, useState } from 'react'
import { Geolocation } from '@capacitor/geolocation'
import { ArrowUpRight, Crosshair, Droplets, LocateFixed, MapPin, Maximize2, Minimize2, Navigation, Search, ShieldCheck, SlidersHorizontal, X } from 'lucide-react'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import './App.css'

type WaterPoint = {
  id: string
  lat: number
  lon: number
  name: string
  status: 'listed' | 'unknown'
  detail: string
  address?: string
  addressDetails?: string
  municipality?: string
  district?: string
  access?: string
  seasonal?: boolean
  source: 'city' | 'station' | 'region' | 'osm'
  tags: Record<string, string>
}

type OverpassElement = {
  type: string
  id: number
  lat?: number
  lon?: number
  center?: { lat: number; lon: number }
  tags?: Record<string, string>
}

type Filter = 'all' | 'listed' | 'unknown'
type CachedPointData = { savedAt: number; points: WaterPoint[] }
type BrusselsWaterRecord = {
  id_opendata?: string
  taf_tap_code?: string
  id_vivaqua?: string
  ref?: string
  name_fr?: string
  name?: string
  status_fr?: string
  access_type_fr?: string
  location_fr?: string
  address_fr?: string
  address_details_fr?: string
  postalcode?: string
  postal_code?: string
  municipality_fr?: string
  territory_fr?: string
  district_fr?: string
  statistical_sector_fr?: string
  geo_point_2d?: { lat: number; lon: number }
  geo_point?: { lat: number; lon: number }
  ifu_type?: string
}

const brusselsBounds = { south: 50.75, west: 4.2, north: 50.93, east: 4.53 }
const regionBounds: L.LatLngBoundsExpression = [
  [brusselsBounds.south, brusselsBounds.west],
  [brusselsBounds.north, brusselsBounds.east],
]
const cacheKey = 'goutte-eau-bruxelles-v1'
const currentMonth = new Date().getMonth()
const cityFountainsOffSeason = currentMonth < 3 || currentMonth > 8
const cityFountainsUrl = 'https://opendata.brussels.be/api/explore/v2.1/catalog/datasets/fontaines-d-eau-potable-gerees-par-la-ville-de-bruxelles/records?limit=100'
const stationFountainsUrl = 'https://opendata.brussels.be/api/explore/v2.1/catalog/datasets/bornes-eau-potable-gratuite-des-gares-sncb-gratis-drinkwatertappunten-van-nmbs-stations/records?limit=100'
const regionalFountainsUrl = 'https://opendata.brussels.be/api/explore/v2.1/catalog/datasets/bornes-d-eau-potable-gerees-par-la-region-drinkwatertappunten-beheerd-door-het-gewest-vivaqua/records?limit=100'

function overpassQueryForBounds(bounds: L.LatLngBounds) {
  const bbox = [bounds.getSouth(), bounds.getWest(), bounds.getNorth(), bounds.getEast()]
    .map((coordinate) => coordinate.toFixed(5))
    .join(',')
  return `[out:json][timeout:25];node[amenity=drinking_water](${bbox});out;`
}

function pointFromElement(element: OverpassElement): WaterPoint | null {
  const lat = element.lat ?? element.center?.lat
  const lon = element.lon ?? element.center?.lon
  const tags = element.tags ?? {}

  if (lat === undefined || lon === undefined || tags.drinking_water === 'no' || tags['drinking_water:legal'] === 'no') {
    return null
  }

  const status = tags.amenity === 'drinking_water' || tags.drinking_water === 'yes' || tags.fountain === 'drinking' || tags.potable === 'yes'

  return {
    id: `${element.type}-${element.id}`,
    lat,
    lon,
    name: tags.name || tags['name:fr'] || tags['name:nl'] || (tags.amenity === 'toilets' ? 'Point d’eau dans des toilettes' : 'Point d’eau public'),
    status: status ? 'listed' : 'unknown',
    detail: tags.operator || tags.opening_hours || '',
    address: [tags['addr:street'], tags['addr:housenumber'], tags['addr:postcode'], tags['addr:city']].filter(Boolean).join(', '),
    municipality: tags['addr:city'],
    source: 'osm',
    tags,
  }
}

function pointFromCityRecord(record: BrusselsWaterRecord): WaterPoint | null {
  const coordinates = record.geo_point_2d
  if (!coordinates || record.status_fr?.toLocaleLowerCase('fr') !== 'actif') return null

  return {
    id: `city-${record.id_opendata ?? `${coordinates.lat}-${coordinates.lon}`}`,
    lat: coordinates.lat,
    lon: coordinates.lon,
    name: record.name_fr || 'Borne à eau potable',
    status: 'listed',
    detail: record.address_details_fr || '',
    address: [record.address_fr, record.postalcode, record.municipality_fr].filter(Boolean).join(', '),
    addressDetails: record.address_details_fr,
    municipality: record.municipality_fr,
    access: record.access_type_fr,
    seasonal: true,
    source: 'city',
    tags: {},
  }
}

function pointFromStationRecord(record: BrusselsWaterRecord): WaterPoint | null {
  const coordinates = record.geo_point_2d
  if (!coordinates) return null

  return {
    id: `station-${record.taf_tap_code ?? `${coordinates.lat}-${coordinates.lon}`}`,
    lat: coordinates.lat,
    lon: coordinates.lon,
    name: record.name_fr || record.name || 'Borne d’eau en gare',
    status: 'listed',
    detail: record.location_fr || '',
    address: [record.postal_code, record.municipality_fr].filter(Boolean).join(' '),
    municipality: record.municipality_fr,
    source: 'station',
    tags: {},
  }
}

function pointFromRegionalRecord(record: BrusselsWaterRecord): WaterPoint | null {
  const coordinates = record.geo_point
  if (!coordinates) return null

  return {
    id: `region-${record.id_vivaqua ?? record.ref ?? `${coordinates.lat}-${coordinates.lon}`}`,
    lat: coordinates.lat,
    lon: coordinates.lon,
    name: `Borne Vivaqua ${record.ref || record.id_vivaqua || ''}`.trim(),
    status: 'listed',
    detail: record.territory_fr || '',
    address: [record.statistical_sector_fr, record.postal_code, record.municipality_fr].filter(Boolean).join(', '),
    municipality: record.municipality_fr,
    district: record.district_fr,
    source: 'region',
    tags: {},
  }
}

function mergePoints(...groups: WaterPoint[][]) {
  const merged: WaterPoint[] = []
  for (const point of groups.flat()) {
    if (merged.some((existing) => {
      if (existing.source === point.source) return false
      const threshold = existing.source === 'osm' || point.source === 'osm' ? 0.03 : 0.005
      return distanceInKm([existing.lat, existing.lon], [point.lat, point.lon]) < threshold
    })) continue
    merged.push(point)
  }
  return merged
}

async function fetchDatasetRecords(url: string, signal: AbortSignal) {
  const response = await fetch(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(12000)]) })
  if (!response.ok) throw new Error(`Open Data Brussels ${response.status}`)
  const data = await response.json() as { results?: BrusselsWaterRecord[] }
  return data.results ?? []
}

function savePointCache(points: WaterPoint[]) {
  try {
    window.localStorage.setItem(cacheKey, JSON.stringify({ savedAt: Date.now(), points } satisfies CachedPointData))
  } catch {}
}

function distanceInKm(from: [number, number], to: [number, number]) {
  const radians = (degrees: number) => (degrees * Math.PI) / 180
  const [lat1, lon1] = from.map(radians)
  const [lat2, lon2] = to.map(radians)
  const latitudeDelta = lat2 - lat1
  const longitudeDelta = lon2 - lon1
  const a = Math.sin(latitudeDelta / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(longitudeDelta / 2) ** 2
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

function formatDistance(distance: number) {
  return distance < 1 ? `${Math.round(distance * 1000)} m` : `${distance.toFixed(1)} km`
}

function pointSourceLabel(source: WaterPoint['source']) {
  if (source === 'city') return 'Ville de Bruxelles'
  if (source === 'station') return 'SNCB'
  if (source === 'region') return 'Région / Vivaqua'
  return 'OpenStreetMap'
}

function App() {
  const mapElement = useRef<HTMLDivElement>(null)
  const map = useRef<L.Map | null>(null)
  const pointLayers = useRef<L.LayerGroup | null>(null)
  const [points, setPoints] = useState<WaterPoint[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [filter, setFilter] = useState<Filter>('all')
  const [search, setSearch] = useState('')
  const [position, setPosition] = useState<[number, number] | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(false)
  const [osmUnavailable, setOsmUnavailable] = useState(false)
  const [reloadKey, setReloadKey] = useState(0)
  const [usingCache, setUsingCache] = useState(false)
  const [locationError, setLocationError] = useState(false)
  const [mapExpanded, setMapExpanded] = useState(false)

  useEffect(() => {
    if (!mapElement.current || map.current) return

    map.current = L.map(mapElement.current, { zoomControl: false, scrollWheelZoom: true }).fitBounds(regionBounds, { padding: [14, 14], maxZoom: 11 })
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    }).addTo(map.current)
    L.control.zoom({ position: 'bottomright' }).addTo(map.current)
    pointLayers.current = L.layerGroup().addTo(map.current)

    return () => {
      map.current?.remove()
      map.current = null
    }
  }, [])

  useEffect(() => {
    const controller = new AbortController()

    async function loadPoints() {
      setLoading(true)
      setLoadError(false)
      setOsmUnavailable(false)
      let cachedPoints: WaterPoint[] = []
      try {
        const storedData = window.localStorage.getItem(cacheKey)
        if (storedData) {
          const cachedData = JSON.parse(storedData) as CachedPointData
          if (Array.isArray(cachedData.points)) {
            cachedPoints = cachedData.points
            setPoints(cachedPoints)
            setUsingCache(true)
            setLoading(false)
          }
        }
      } catch {
        cachedPoints = []
      }

      const [cityResult, stationResult, regionalResult] = await Promise.allSettled([
        fetchDatasetRecords(cityFountainsUrl, controller.signal),
        fetchDatasetRecords(stationFountainsUrl, controller.signal),
        fetchDatasetRecords(regionalFountainsUrl, controller.signal),
      ])
      if (controller.signal.aborted) return

      const cityPoints = cityResult.status === 'fulfilled'
        ? cityResult.value.map(pointFromCityRecord).filter((point): point is WaterPoint => point !== null)
        : []
      const stationPoints = stationResult.status === 'fulfilled'
        ? stationResult.value.map(pointFromStationRecord).filter((point): point is WaterPoint => point !== null)
        : []
      const regionalPoints = regionalResult.status === 'fulfilled'
        ? regionalResult.value.map(pointFromRegionalRecord).filter((point): point is WaterPoint => point !== null)
        : []
      const officialPoints = mergePoints(cityPoints, stationPoints, regionalPoints)

      if (officialPoints.length > 0) {
        setPoints(officialPoints)
        setLoadError(false)
        setUsingCache(false)
        setLoading(false)
        savePointCache(officialPoints)
      }

      const queryBounds = map.current?.getBounds() ?? L.latLngBounds([
        L.latLng(brusselsBounds.south, brusselsBounds.west),
        L.latLng(brusselsBounds.north, brusselsBounds.east),
      ])
      const overpassQuery = overpassQueryForBounds(queryBounds)
      const endpoints = [
        'https://overpass-api.de/api/interpreter',
        'https://overpass.kumi.systems/api/interpreter',
      ]

      for (const endpoint of endpoints) {
        try {
          const response = await fetch(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
            body: new URLSearchParams({ data: overpassQuery }),
            signal: AbortSignal.any([controller.signal, AbortSignal.timeout(16000)]),
          })
          if (!response.ok) throw new Error(`Overpass ${response.status}`)
          const data = await response.json() as { elements: OverpassElement[] }
          const osmPoints = data.elements.map(pointFromElement).filter((point): point is WaterPoint => point !== null)
          const cachedOfficialPoints = cachedPoints.filter((point) => point.source !== 'osm')
          const freshPoints = mergePoints(officialPoints.length > 0 ? officialPoints : cachedOfficialPoints, osmPoints)
          setPoints(freshPoints)
          setLoadError(false)
          setOsmUnavailable(false)
          setUsingCache(false)
          savePointCache(freshPoints)
          setLoading(false)
          return
        } catch {
          if (controller.signal.aborted) return
        }
      }

      const cachedOsmPoints = cachedPoints.filter((point) => point.source === 'osm')
      const fallbackPoints = officialPoints.length > 0
        ? mergePoints(officialPoints, cachedOsmPoints)
        : cachedPoints
      setPoints(fallbackPoints)
      setOsmUnavailable(true)
      setLoadError(fallbackPoints.length === 0)
      setUsingCache(cachedOsmPoints.length > 0 || (officialPoints.length === 0 && cachedPoints.length > 0))
      setLoading(false)
    }

    void loadPoints()
    return () => controller.abort()
  }, [reloadKey])

  const filteredPoints = points
    .filter((point) => filter === 'all' || point.status === filter)
    .filter((point) => `${point.name} ${point.detail} ${point.address ?? ''} ${point.addressDetails ?? ''} ${point.municipality ?? ''}`.toLocaleLowerCase('fr').includes(search.trim().toLocaleLowerCase('fr')))
    .sort((left, right) => {
      if (!position) return left.name.localeCompare(right.name, 'fr')
      return distanceInKm(position, [left.lat, left.lon]) - distanceInKm(position, [right.lat, right.lon])
    })
  const selectedPoint = points.find((point) => point.id === selectedId) ?? null
  const cityPointCount = points.filter((point) => point.source === 'city').length
  const stationPointCount = points.filter((point) => point.source === 'station').length
  const regionalPointCount = points.filter((point) => point.source === 'region').length
  const osmPointCount = points.filter((point) => point.source === 'osm').length
  const nearestPoint = position ? filteredPoints[0] : null

  useEffect(() => {
    if (!map.current || !pointLayers.current) return
    pointLayers.current.clearLayers()

    for (const point of filteredPoints) {
      const selected = point.id === selectedId
      const marker = L.marker([point.lat, point.lon], {
        icon: L.divIcon({
          className: 'water-marker-wrap',
          html: `<span class="water-marker ${point.status === 'unknown' ? 'is-unknown' : ''} ${selected ? 'is-selected' : ''}"><span></span></span>`,
          iconSize: [32, 40],
          iconAnchor: [16, 36],
        }),
        title: point.name,
        keyboard: true,
      }).on('click', () => setSelectedId(point.id))
      pointLayers.current.addLayer(marker)
    }

    if (position) {
      L.circleMarker(position, { radius: 8, color: '#fff', weight: 3, fillColor: '#3f71d8', fillOpacity: 1 }).addTo(pointLayers.current)
      L.circle(position, { radius: 90, color: '#3f71d8', weight: 1, fillColor: '#3f71d8', fillOpacity: 0.08 }).addTo(pointLayers.current)
    }
  }, [filteredPoints, position, selectedId])

  useEffect(() => {
    if (!selectedPoint || !map.current) return
    map.current.flyTo([selectedPoint.lat, selectedPoint.lon], Math.max(map.current.getZoom(), 16), { duration: 0.45 })
  }, [selectedPoint])

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => map.current?.invalidateSize({ pan: false }))
    if (!mapExpanded) return () => window.cancelAnimationFrame(frame)

    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'

    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === 'Escape') setMapExpanded(false)
    }

    window.addEventListener('keydown', closeOnEscape)
    return () => {
      window.cancelAnimationFrame(frame)
      window.removeEventListener('keydown', closeOnEscape)
      document.body.style.overflow = previousOverflow
    }
  }, [mapExpanded])

  async function locateUser() {
    setLocationError(false)
    try {
      const { coords } = await Geolocation.getCurrentPosition({
        enableHighAccuracy: true,
        timeout: 10000,
        maximumAge: 30000,
      })
      const userPosition: [number, number] = [coords.latitude, coords.longitude]
      setPosition(userPosition)
      map.current?.flyTo(userPosition, 16, { duration: 0.6 })
    } catch {
      setLocationError(true)
    }
  }

  function selectPoint(point: WaterPoint) {
    setSelectedId(point.id)
    map.current?.flyTo([point.lat, point.lon], Math.max(map.current.getZoom(), 16), { duration: 0.45 })
  }

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <header className="app-header">
          <div className="brand-mark" aria-hidden="true"><Droplets size={22} strokeWidth={2.2} /></div>
          <div className="brand-copy"><span className="eyebrow">BRUXELLES · 19 COMMUNES</span><h1>Goutte à goutte</h1></div>
          <button type="button" className="icon-button locate-mobile" onClick={locateUser} aria-label="Me localiser" title="Me localiser"><LocateFixed size={20} /></button>
        </header>

        <section className="finder" aria-label="Recherche et filtres">
          <label className="search-box">
            <Search size={18} aria-hidden="true" />
            <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Chercher un point d’eau" aria-label="Chercher un point d’eau" />
            {search && <button type="button" className="clear-search" onClick={() => setSearch('')} aria-label="Effacer la recherche"><X size={16} /></button>}
          </label>
          <div className="filter-row" role="group" aria-label="Filtrer les points d’eau">
            <span className="filter-icon"><SlidersHorizontal size={15} /></span>
            {([
              ['all', 'Tous'],
              ['listed', 'Indiqués potables'],
              ['unknown', 'À vérifier'],
            ] as [Filter, string][]).map(([value, label]) => (
              <button key={value} type="button" className={`filter-button ${filter === value ? 'is-active' : ''}`} onClick={() => setFilter(value)} aria-pressed={filter === value}>{label}</button>
            ))}
          </div>
        </section>

        <section className="results" aria-label="Points d’eau recensés">
          <div className="results-heading">
            <div><p className="eyebrow">À PROXIMITÉ</p><h2>{loading ? 'Recherche en cours…' : loadError ? 'Données indisponibles' : `${filteredPoints.length} point${filteredPoints.length === 1 ? '' : 's'} recensé${filteredPoints.length === 1 ? '' : 's'}`}</h2></div>
            {position && nearestPoint && <span className="nearest-label"><Crosshair size={13} /> {formatDistance(distanceInKm(position, [nearestPoint.lat, nearestPoint.lon]))}</span>}
          </div>

          {loading && <div className="state-message"><span className="spinner" /> Chargement des points cartographiés…</div>}
          {loadError && <div className="state-message error-state"><p>Les données ne répondent pas pour le moment.</p><button type="button" className="retry-button" onClick={() => setReloadKey((key) => key + 1)}>Réessayer</button></div>}
          {!loading && !loadError && filteredPoints.length === 0 && <div className="state-message">Aucun point ne correspond à cette recherche.</div>}

          <div className="point-list">
            {filteredPoints.map((point) => (
              <button key={point.id} type="button" className={`point-row ${selectedId === point.id ? 'is-selected' : ''}`} onClick={() => selectPoint(point)}>
                <span className={`point-symbol ${point.status === 'unknown' ? 'is-unknown' : ''}`}><Droplets size={17} /></span>
                <span className="point-copy">
                  <span className="point-name">{point.name}</span>
                  <span className={`point-status ${point.source === 'city' && cityFountainsOffSeason ? 'is-seasonal' : point.status === 'listed' ? 'is-listed' : ''}`}>
                    {point.source === 'city' && cityFountainsOffSeason ? 'Hors saison (avr.–sept.)' : point.status === 'listed' ? 'Potable indiqué' : 'Potabilité à vérifier'} · {pointSourceLabel(point.source)}
                  </span>
                  {(point.address || point.detail) && <span className="point-address">{point.address || point.detail}</span>}
                </span>
                {position && <span className="point-distance">{formatDistance(distanceInKm(position, [point.lat, point.lon]))}</span>}
                <ArrowUpRight className="row-arrow" size={16} aria-hidden="true" />
              </button>
            ))}
          </div>

          <footer className="data-note"><ShieldCheck size={15} /><span>{loadError ? 'Les sources ne répondent pas et aucune carte n’est enregistrée dans ce navigateur.' : usingCache ? `Réseau indisponible : dernière carte enregistrée conservée.${osmUnavailable ? ' Le complément OSM des autres communes est indisponible.' : ''} Les bornes de la Ville sont saisonnières (avril à septembre).` : `${cityPointCount} bornes Ville · ${stationPointCount} points SNCB · ${regionalPointCount} Région/Vivaqua · ${osmPointCount} compléments OpenStreetMap.${osmUnavailable ? ' OSM est indisponible : la couverture des 19 communes est incomplète.' : ''} Les bornes de la Ville fonctionnent d’avril à septembre.`}</span>{osmUnavailable && points.length > 0 && <button type="button" className="retry-button" onClick={() => setReloadKey((key) => key + 1)}>Réessayer OSM</button>}</footer>
        </section>
      </aside>

      <section className={`map-panel ${mapExpanded ? 'is-expanded' : ''}`} aria-label="Carte des points d’eau">
        <div id="brussels-map" ref={mapElement} className="map-canvas" />
        <div className="map-topline"><span className="live-dot" /> Carte de Bruxelles-Capitale <span className="map-separator">/</span> {loadError ? 'hors ligne' : `${points.length} points`}</div>
        <button type="button" className="icon-button locate-button" onClick={locateUser} aria-label="Me localiser sur la carte" title="Me localiser"><LocateFixed size={20} /></button>
        <button type="button" className="icon-button expand-button" onClick={() => setMapExpanded((expanded) => !expanded)} aria-label={mapExpanded ? 'Réduire la carte' : 'Agrandir la carte'} aria-expanded={mapExpanded} aria-controls="brussels-map" title={mapExpanded ? 'Réduire la carte' : 'Agrandir la carte'}>{mapExpanded ? <Minimize2 size={19} /> : <Maximize2 size={19} />}</button>

        {locationError && <div className="map-toast" role="status">Position indisponible. Autorise la localisation dans ton navigateur.</div>}

        {selectedPoint && <div className="selected-card">
          <button type="button" className="selected-close" onClick={() => setSelectedId(null)} aria-label="Fermer la fiche"><X size={17} /></button>
          <div className={`selected-icon ${selectedPoint.status === 'unknown' ? 'is-unknown' : ''}`}><Droplets size={19} /></div>
          <div className="selected-content">
            <span className="eyebrow">{selectedPoint.source === 'city' && cityFountainsOffSeason ? 'HORS SAISON · VILLE DE BRUXELLES' : selectedPoint.status === 'listed' ? `EAU POTABLE · ${pointSourceLabel(selectedPoint.source).toLocaleUpperCase('fr')}` : 'STATUT À VÉRIFIER · OPENSTREETMAP'}</span>
            <h2>{selectedPoint.name}</h2>
            {selectedPoint.address && <p className="point-address-detail">{selectedPoint.address}</p>}
            {selectedPoint.detail && <p>{selectedPoint.detail}</p>}
            {selectedPoint.access && <p>{selectedPoint.access}</p>}
            <p className="selected-source">Source : <a href={selectedPoint.source === 'city' ? 'https://opendata.brussels.be/explore/assets/fontaines-d-eau-potable-gerees-par-la-ville-de-bruxelles/view/?flg=fr-fr' : selectedPoint.source === 'station' ? 'https://opendata.brussels.be/explore/assets/bornes-eau-potable-gratuite-des-gares-sncb-gratis-drinkwatertappunten-van-nmbs-stations/view/?flg=fr-fr' : selectedPoint.source === 'region' ? 'https://opendata.bruxelles.be/explore/assets/bornes-d-eau-potable-gerees-par-la-region-drinkwatertappunten-beheerd-door-het-gewest-vivaqua/view/?flg=fr-fr' : 'https://www.openstreetmap.org/'} target="_blank" rel="noreferrer">{pointSourceLabel(selectedPoint.source)}</a></p>
            <a className="route-link" href={`https://www.google.com/maps/dir/?api=1&destination=${selectedPoint.lat},${selectedPoint.lon}`} target="_blank" rel="noreferrer"><Navigation size={15} /> Itinéraire <ArrowUpRight size={14} /></a>
          </div>
        </div>}

        {!position && !selectedPoint && <button type="button" className="location-hint" onClick={locateUser}><MapPin size={15} /> Afficher les points près de moi <span>→</span></button>}
      </section>
    </main>
  )
}

export default App
