import React, { useState, useEffect, useRef } from 'react';
import { 
  Globe2, Ruler, Mountain, Info, Crosshair, MapPin, 
  Eraser, Loader2, AlertTriangle, Droplets, Copy,
  PlusCircle, Building2, Star, Trash2, X
} from 'lucide-react';

// === SISTEMA GLOBAL DE CACHÉ DE SCRIPTS ===
const SCRIPT_CACHE = {};

const loadExternalScript = (urls) => {
  const primarySrc = urls[0];
  if (SCRIPT_CACHE[primarySrc]) return SCRIPT_CACHE[primarySrc];

  const promise = (async () => {
    for (const src of urls) {
      try {
        await new Promise((resolve, reject) => {
          let script = document.querySelector(`script[src="${src}"]`);
          if (script) {
            if (script.getAttribute('data-loaded') === 'true') {
              resolve();
            } else {
              script.addEventListener('load', resolve);
              script.addEventListener('error', reject);
            }
            return;
          }

          script = document.createElement('script');
          script.src = src;
          script.onload = () => {
            script.setAttribute('data-loaded', 'true');
            resolve();
          };
          script.onerror = reject;
          document.head.appendChild(script);
        });
        return; 
      } catch (error) {
        console.warn(`Fallback: Falló al cargar ${src}, intentando el siguiente...`);
      }
    }
    throw new Error(`Todos los servidores de respaldo fallaron para ${primarySrc}`);
  })();

  SCRIPT_CACHE[primarySrc] = promise;
  return promise;
};

// === FUNCIONES MATEMÁTICAS ESFÉRICAS PARA COMPARACIÓN DE TAMAÑOS ===
const toRad = x => x * Math.PI / 180;
const toDeg = x => x * 180 / Math.PI;

const calculateDistance = (lat1, lon1, lat2, lon2) => {
  const R = 6371; 
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return (R * c).toFixed(2);
};

const getDistanceAndBearing = (lat1, lon1, lat2, lon2) => {
  const R = 6371;
  const phi1 = toRad(lat1), phi2 = toRad(lat2);
  const dPhi = toRad(lat2 - lat1), dLambda = toRad(lon2 - lon1);
  const a = Math.sin(dPhi/2)**2 + Math.cos(phi1)*Math.cos(phi2)*Math.sin(dLambda/2)**2;
  const dist = R * (2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a)));
  const y = Math.sin(dLambda) * Math.cos(phi2);
  const x = Math.cos(phi1)*Math.sin(phi2) - Math.sin(phi1)*Math.cos(phi2)*Math.cos(dLambda);
  const brng = toDeg(Math.atan2(y, x));
  return { dist, brng };
};

const getDestination = (lat1, lon1, dist, brng) => {
  const R = 6371;
  const phi1 = toRad(lat1);
  const lambda1 = toRad(lon1);
  const theta = toRad(brng);
  const delta = dist / R;
  let arg = Math.sin(phi1)*Math.cos(delta) + Math.cos(phi1)*Math.sin(delta)*Math.cos(theta);
  if (arg > 1) arg = 1; if (arg < -1) arg = -1;
  const phi2 = Math.asin(arg);
  let lambda2 = lambda1 + Math.atan2(Math.sin(theta)*Math.sin(delta)*Math.cos(phi1), Math.cos(delta)-Math.sin(phi1)*Math.sin(phi2));
  let lng = toDeg(lambda2);
  lng = ((lng + 540) % 360) - 180; 
  return { lat: toDeg(phi2), lng };
};

const getCentroid = (feature) => {
    let minLat = 90, maxLat = -90, minLng = 180, maxLng = -180;
    const processCoord = (coord) => {
        if (coord[1] < minLat) minLat = coord[1];
        if (coord[1] > maxLat) maxLat = coord[1];
        if (coord[0] < minLng) minLng = coord[0];
        if (coord[0] > maxLng) maxLng = coord[0];
    };
    if (feature.geometry.type === 'Polygon') {
        feature.geometry.coordinates.forEach(ring => ring.forEach(processCoord));
    } else if (feature.geometry.type === 'MultiPolygon') {
        feature.geometry.coordinates.forEach(polygon => polygon.forEach(ring => ring.forEach(processCoord)));
    }
    return { lat: (minLat + maxLat) / 2, lng: (minLng + maxLng) / 2 };
};

const preprocessFeature = (feature, centroidLat, centroidLng) => {
    const processRing = (ring) => ring.map(coord => getDistanceAndBearing(centroidLat, centroidLng, coord[1], coord[0]));
    if (feature.geometry.type === 'Polygon') return feature.geometry.coordinates.map(processRing);
    if (feature.geometry.type === 'MultiPolygon') return feature.geometry.coordinates.map(polygon => polygon.map(processRing));
    return null;
};

const translateFeature = (processedRings, newLat, newLng, type) => {
    const translateRing = (ring) => ring.map(pt => {
        const { lat, lng } = getDestination(newLat, newLng, pt.dist, pt.brng);
        return [lng, lat];
    });
    if (type === 'Polygon') return { type, coordinates: processedRings.map(translateRing) };
    if (type === 'MultiPolygon') return { type, coordinates: processedRings.map(polygon => polygon.map(translateRing)) };
};

const checkDisputedStatus = (feature) => {
  if (!feature || !feature.properties) return false;
  const p = feature.properties;
  const type = (p.TYPE || '').toLowerCase();
  const name = (p.NAME || p.ADMIN || '').toLowerCase();
  return type.includes('disputed') || type.includes('indeterminate') || p.STATUS?.toLowerCase().includes('dispute') ||
         ['w. sahara', 'somaliland', 'kashmir', 'taiwan', 'kosovo', 'palestine', 'antarctica'].includes(name);
};

const App = () => {
  const globeContainerRef = useRef(null);
  const globeInstance = useRef(null);
  const isInitializing = useRef(false); 
  
  const [geoData, setGeoData] = useState({ features: [] }); 
  const [disputedAreas, setDisputedAreas] = useState([]);
  const [rivers, setRivers] = useState([]); 
  
  const [hoverD, setHoverD] = useState();
  const [mode, setMode] = useState('explore'); 
  const [isEngineLoading, setIsEngineLoading] = useState(true);
  const [engineError, setEngineError] = useState(false);
  const [vectorsLoading, setVectorsLoading] = useState(true);
  
  const [measurePoints, setMeasurePoints] = useState([]);
  const [distance, setDistance] = useState(null);
  const [draggedCountryName, setDraggedCountryName] = useState(null);
  const [windowWidth, setWindowWidth] = useState(window.innerWidth);

  // ESTADOS NUEVOS PARA MARCADORES
  const [markers, setMarkers] = useState([]);
  const [markerType, setMarkerType] = useState('city');
  const [pendingMarker, setPendingMarker] = useState(null);
  const [markerNameInput, setMarkerNameInput] = useState('');

  const modeRef = useRef(mode);
  const measurePointsRef = useRef(measurePoints);
  const riversRef = useRef(rivers); 
  
  const compareDataRef = useRef(null);
  const draggedPathsRef = useRef([]);

  useEffect(() => { modeRef.current = mode; }, [mode]);
  useEffect(() => { measurePointsRef.current = measurePoints; }, [measurePoints]);
  useEffect(() => { riversRef.current = rivers; }, [rivers]);

  // 1. Cargar datos espaciales 
  useEffect(() => {
    let isMounted = true;
    const loadGeoData = async () => {
      try {
        const [countriesRes, lakesRes, riversRes] = await Promise.all([
          fetch('https://raw.githubusercontent.com/vasturiano/react-globe.gl/master/example/datasets/ne_110m_admin_0_countries.geojson').then(r => r.json()).catch(() => ({features: []})),
          fetch('https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_50m_lakes.geojson').then(r => r.json()).catch(() => ({features: []})),
          fetch('https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_50m_rivers_lake_centerlines.geojson').then(r => r.json()).catch(() => ({features: []}))
        ]);

        if (!isMounted) return;

        const disputed = countriesRes.features.filter(checkDisputedStatus);
        setDisputedAreas(disputed);
        setGeoData({ features: [...countriesRes.features, ...lakesRes.features] });

        let parsedRivers = [];
        if (riversRes && riversRes.features) {
          riversRes.features.forEach(f => {
              if (f.geometry?.type === 'LineString') {
                  parsedRivers.push(f.geometry.coordinates.map(c => ({ lat: c[1], lng: c[0], alt: 0.007 })));
              } else if (f.geometry?.type === 'MultiLineString') {
                  f.geometry.coordinates.forEach(line => {
                      parsedRivers.push(line.map(c => ({ lat: c[1], lng: c[0], alt: 0.007 })));
                  });
              }
          });
        }
        setRivers(parsedRivers);

      } catch (error) {
        console.error("Error cargando mapas vectoriales", error);
      } finally {
        if (isMounted) setVectorsLoading(false);
      }
    };
    
    loadGeoData();
    return () => { isMounted = false; };
  }, []);

  const updateDraggedFeature = (newLat, newLng) => {
      if (!compareDataRef.current || !globeInstance.current) return;
      const newGeom = translateFeature(compareDataRef.current.processedRings, newLat, newLng, compareDataRef.current.type);
      
      const draggedPaths = [];
      const processRingToPath = (ring) => ring.map(coord => ({ lat: coord[1], lng: coord[0], alt: 0.015 }));

      if (newGeom.type === 'Polygon') {
          newGeom.coordinates.forEach(ring => draggedPaths.push({ points: processRingToPath(ring), type: 'dragged' }));
      } else if (newGeom.type === 'MultiPolygon') {
          newGeom.coordinates.forEach(poly => poly.forEach(ring => draggedPaths.push({ points: processRingToPath(ring), type: 'dragged' })));
      }

      draggedPathsRef.current = draggedPaths;
      
      const allPaths = [
          ...riversRef.current.map(r => ({ points: r, type: 'river' })), 
          ...draggedPaths
      ];
      globeInstance.current.pathsData(allPaths);
  };

  // 2. Inicializar Motor 3D y Dependencias
  useEffect(() => {
    const handleResize = () => setWindowWidth(window.innerWidth);
    window.addEventListener('resize', handleResize);

    const initGlobe = () => {
      if (!globeContainerRef.current || !window.Globe || !window.THREE || globeInstance.current || isInitializing.current) return;
      
      try {
        isInitializing.current = true;
        const container = globeContainerRef.current;
        
        if (container.clientWidth === 0 || container.clientHeight === 0) {
           isInitializing.current = false;
           setTimeout(initGlobe, 100);
           return;
        }

        const globe = window.Globe()(container)
          .width(container.clientWidth)
          .height(container.clientHeight)
          .globeImageUrl("https://unpkg.com/three-globe/example/img/earth-blue-marble.jpg")
          .bumpImageUrl("https://unpkg.com/three-globe/example/img/earth-topology.png")
          .backgroundImageUrl("https://unpkg.com/three-globe/example/img/night-sky.png")
          .polygonAltitude(d => d.properties?.featurecla === 'Lake' ? 0.006 : 0.005)
          .polygonCapColor(d => {
            if (d.properties?.featurecla === 'Lake') return 'rgba(14, 165, 233, 0.6)';
            if (d === hoverD) return 'rgba(255, 95, 31, 0.2)'; 
            return 'rgba(0,0,0,0)';
          })
          .polygonSideColor(() => 'rgba(0,0,0,0)')
          .polygonStrokeColor(d => {
            if (d.properties?.featurecla === 'Lake') return 'rgba(14, 165, 233, 0.9)'; 
            if (checkDisputedStatus(d)) return '#FF00FF'; 
            return modeRef.current === 'explore' ? '#FF5F1F' : 'rgba(255, 95, 31, 0.3)'; 
          })
          .pathPoints('points')
          .pathPointLat(p => p.lat)
          .pathPointLng(p => p.lng)
          .pathPointAlt(p => p.alt || 0.007)
          .pathColor(path => path.type === 'dragged' ? 'rgba(255, 0, 255, 0.9)' : 'rgba(14, 165, 233, 0.8)') 
          .pathStroke(path => path.type === 'dragged' ? 2.5 : 1.5) 
          .arcStartLat(d => d.startLat)
          .arcStartLng(d => d.startLng)
          .arcEndLat(d => d.endLat)
          .arcEndLng(d => d.endLng)
          .arcColor(() => '#10b981')
          .arcDashLength(0.5)
          .arcDashGap(0.1)
          .arcDashAnimateTime(2000)
          .labelLat(d => d.lat)
          .labelLng(d => d.lng)
          .labelDotRadius(0.5)
          .labelDotOrientation(() => 'bottom')
          .labelColor(() => 'white')
          .labelText(() => '')
          .htmlElementsData(markers)
          .htmlElement(d => {
              const el = document.createElement('div');
              el.innerHTML = `
                  <div class="flex flex-col items-center pointer-events-none group">
                      <div class="p-1 bg-slate-900/90 border border-white/20 rounded shadow-lg transition-transform group-hover:scale-125">
                          ${d.type === 'city' ? '📍' : d.type === 'monument' ? '🏛️' : '⭐'}
                      </div>
                      <span class="mt-1 px-1.5 py-0.5 bg-black/70 text-[9px] text-white font-bold rounded border border-white/10 uppercase whitespace-nowrap">
                          ${d.label}
                      </span>
                  </div>
              `;
              return el;
          });

        setTimeout(() => {
          if (!globeInstance.current) return; 
          try {
            const material = globe.globeMaterial();
            if (material) {
               material.shininess = 0.05; 
               material.bumpScale = 25; 
               material.needsUpdate = true;
            }
            const scene = globe.scene();
            const lights = scene.children.filter(obj => obj.type && obj.type.includes('Light'));
            lights.forEach(light => {
               if (light.type === 'DirectionalLight') light.intensity = 1.0; 
               if (light.type === 'AmbientLight') light.intensity = 1.5; 
            });
          } catch (e) { console.error("Error configurando luces", e); }
        }, 500);

        globe.controls().autoRotate = false; 
        globe.pointOfView({ lat: 20, lng: -100, altitude: 2 });

        globe.onPolygonHover(polygon => {
          setHoverD(polygon);
          globe.polygonCapColor(globe.polygonCapColor()); 
        });

        const handleRightClick = () => {
           if (modeRef.current === 'compare' && compareDataRef.current) {
              compareDataRef.current = null;
              draggedPathsRef.current = [];
              setDraggedCountryName(null);
              if (globeInstance.current) {
                 const allPaths = riversRef.current.map(r => ({ points: r, type: 'river' }));
                 globeInstance.current.pathsData(allPaths);
              }
           }
        };
        globe.onGlobeRightClick(handleRightClick);
        globe.onPolygonRightClick(handleRightClick);

        const handleMapInteraction = (event_or_polygon, _, coords_if_polygon) => {
          if (!globeInstance.current) return;
          globeInstance.current.controls().autoRotate = false;
          
          const isPolygonClick = event_or_polygon && event_or_polygon.properties;
          const coords = coords_if_polygon || event_or_polygon;

          if (modeRef.current === 'measure' && coords && coords.lat !== undefined && coords.lng !== undefined) {
            const currentPoints = measurePointsRef.current;
            let newPoints;
            if (currentPoints.length > 2) {
              newPoints = [coords];
              setDistance(null);
            } else {
              newPoints = [...currentPoints, coords];
              if (newPoints.length === 2) {
                const dist = calculateDistance(newPoints[0].lat, newPoints[0].lng, newPoints[1].lat, newPoints[1].lng);
                setDistance(dist);
              }
            }
            setMeasurePoints(newPoints);
          } else if (modeRef.current === 'addMarker' && coords) {
              setPendingMarker(coords);
          } else if (modeRef.current === 'compare' && isPolygonClick) {
             const feature = event_or_polygon;
             const centroid = getCentroid(feature);
             const processedRings = preprocessFeature(feature, centroid.lat, centroid.lng);
             
             compareDataRef.current = {
                 processedRings,
                 type: feature.geometry.type,
                 name: feature.properties.NAME || feature.properties.ADMIN || 'Territorio'
             };
             setDraggedCountryName(compareDataRef.current.name);
             updateDraggedFeature(centroid.lat, centroid.lng);
          }
        };

        globe.onGlobeClick(handleMapInteraction);      
        globe.onPolygonClick(handleMapInteraction);    

        globeInstance.current = globe;
        setIsEngineLoading(false); 
      } catch (err) {
        console.error("Error iniciando el globo:", err);
        setEngineError(true);
        setIsEngineLoading(false);
      } finally {
        isInitializing.current = false;
      }
    };

    const loadDependencies = async () => {
      try {
        await loadExternalScript([
          'https://cdn.jsdelivr.net/npm/three@0.146.0/build/three.min.js',
          'https://cdnjs.cloudflare.com/ajax/libs/three.js/0.146.0/three.min.js',
          'https://cdn.jsdelivr.net/npm/three@0.146.0/build/three.min.js'
        ]);
        await loadExternalScript([
          'https://unpkg.com/globe.gl@2.27.2/dist/globe.gl.min.js',
          'https://cdn.jsdelivr.net/npm/globe.gl@2.27.2/dist/globe.gl.min.js'
        ]);
        setTimeout(initGlobe, 100);
      } catch (error) {
        setEngineError(true);
        setIsEngineLoading(false);
      }
    };

    loadDependencies();

    return () => {
      window.removeEventListener('resize', handleResize);
      if (globeInstance.current) {
        try { if (typeof globeInstance.current._destructor === 'function') globeInstance.current._destructor(); } 
        catch (e) {}
      }
      isInitializing.current = false;
      globeInstance.current = null;
      if (globeContainerRef.current) globeContainerRef.current.innerHTML = '';
    };
  }, []);

  useEffect(() => {
      const container = globeContainerRef.current;
      if (!container) return;
      let animationFrameId;
      const handleMouseMove = (e) => {
          if (modeRef.current === 'compare' && compareDataRef.current && globeInstance.current) {
              if (animationFrameId) cancelAnimationFrame(animationFrameId);
              animationFrameId = requestAnimationFrame(() => {
                  const rect = container.getBoundingClientRect();
                  const coords = globeInstance.current.toGlobeCoords(e.clientX - rect.left, e.clientY - rect.top);
                  if (coords) updateDraggedFeature(coords.lat, coords.lng);
              });
          }
      };
      container.addEventListener('mousemove', handleMouseMove);
      return () => {
          container.removeEventListener('mousemove', handleMouseMove);
          if (animationFrameId) cancelAnimationFrame(animationFrameId);
      };
  }, []);

  // 3. Sincronización de Datos en tiempo real
  useEffect(() => {
    if (globeInstance.current && !isEngineLoading && geoData.features.length > 0) {
      globeInstance.current.polygonsData(geoData.features);
    }
  }, [geoData, isEngineLoading]);

  useEffect(() => {
    if (globeInstance.current && !isEngineLoading && riversRef.current.length > 0) {
      const pathsData = riversRef.current.map(r => ({ points: r, type: 'river' }));
      globeInstance.current.pathsData(pathsData);
    }
  }, [rivers, isEngineLoading]);

  useEffect(() => {
    if (globeInstance.current && !isEngineLoading) {
      if (measurePoints.length === 2) {
        const arcData = [{ startLat: measurePoints[0].lat, startLng: measurePoints[0].lng, endLat: measurePoints[1].lat, endLng: measurePoints[1].lng }];
        globeInstance.current.arcsData(arcData);
      } else {
        globeInstance.current.arcsData([]);
      }
      globeInstance.current.labelsData(measurePoints);
    }
  }, [measurePoints, isEngineLoading]);

  // Actualizar marcadores en el globo
  useEffect(() => {
    if (globeInstance.current) globeInstance.current.htmlElementsData(markers);
  }, [markers]);

  const saveMarker = () => {
      if (markerNameInput.trim() && pendingMarker) {
          setMarkers([...markers, { ...pendingMarker, label: markerNameInput, type: markerType }]);
          setPendingMarker(null);
          setMarkerNameInput('');
      }
  };

  return (
    <div className="flex flex-col md:flex-row h-screen bg-slate-950 text-slate-100 font-sans overflow-hidden selection:bg-blue-500/30">
      
      <aside className="w-full md:w-80 bg-slate-900 border-r border-slate-800 p-5 flex flex-col z-10 shadow-2xl overflow-y-auto custom-scrollbar">
        <header className="mb-6 flex-shrink-0">
          <h1 className="text-2xl font-bold bg-clip-text text-transparent bg-gradient-to-r from-orange-400 to-fuchsia-400 flex items-center gap-2">
            <Globe2 className="w-6 h-6 text-orange-400" />
            Atlas Interactivo
          </h1>
          <p className="text-xs text-slate-500 mt-2 uppercase tracking-wider font-semibold">
            By KnightRlex
          </p>
        </header>

        <div className="space-y-3 mb-6 flex-shrink-0">
          <button onClick={() => setMode('explore')} className={`w-full flex items-center gap-3 p-3 rounded-xl transition-all border ${mode === 'explore' ? 'bg-orange-900/30 border-orange-500 text-orange-400' : 'bg-slate-800 border-slate-700 text-slate-300 hover:bg-slate-700'}`}>
            <Crosshair className="w-5 h-5" />
            <div className="text-left"><div className="font-medium text-xs uppercase tracking-widest">Exploración Táctica</div></div>
          </button>

          <button onClick={() => { setMode('measure'); setMeasurePoints([]); setDistance(null); }} className={`w-full flex items-center gap-3 p-3 rounded-xl transition-all border ${mode === 'measure' ? 'bg-emerald-600/20 border-emerald-500 text-emerald-300' : 'bg-slate-800 border-slate-700 text-slate-300 hover:bg-slate-700'}`}>
            <Ruler className="w-5 h-5" />
            <div className="text-left"><div className="font-medium text-xs uppercase tracking-widest">Regla Geométrica</div></div>
          </button>

          <button onClick={() => setMode('compare')} className={`w-full flex items-center gap-3 p-3 rounded-xl transition-all border ${mode === 'compare' ? 'bg-fuchsia-600/20 border-fuchsia-500 text-fuchsia-300' : 'bg-slate-800 border-slate-700 text-slate-300 hover:bg-slate-700'}`}>
            <Copy className="w-5 h-5" />
            <div className="text-left"><div className="font-medium text-xs uppercase tracking-widest">Comparación Territorial</div></div>
          </button>

          {/* OPCIÓN NUEVA: MARCADORES */}
          <div className={`p-3 rounded-xl border transition-all ${mode === 'addMarker' ? 'bg-blue-950/40 border-blue-500' : 'bg-slate-800/50 border-slate-700'}`}>
            <button onClick={() => setMode('addMarker')} className={`w-full flex items-center gap-3 text-xs font-bold uppercase tracking-widest ${mode === 'addMarker' ? 'text-blue-400' : 'text-slate-400'}`}>
              <PlusCircle className="w-5 h-5" /> Marcadores
            </button>
            {mode === 'addMarker' && (
                <div className="flex gap-2 mt-4 justify-between">
                    <button onClick={() => setMarkerType('city')} className={`flex-1 p-2 rounded-lg border flex flex-col items-center transition-colors ${markerType === 'city' ? 'bg-blue-600 border-blue-400 text-white' : 'bg-slate-900 border-slate-700 text-slate-500'}`}>
                        <MapPin className="w-4 h-4 mb-1" /> <span className="text-[8px] font-bold tracking-tighter">CIUDAD</span>
                    </button>
                    <button onClick={() => setMarkerType('monument')} className={`flex-1 p-2 rounded-lg border flex flex-col items-center transition-colors ${markerType === 'monument' ? 'bg-blue-600 border-blue-400 text-white' : 'bg-slate-900 border-slate-700 text-slate-500'}`}>
                        <Building2 className="w-4 h-4 mb-1" /> <span className="text-[8px] font-bold tracking-tighter">HITO</span>
                    </button>
                    <button onClick={() => setMarkerType('info')} className={`flex-1 p-2 rounded-lg border flex flex-col items-center transition-colors ${markerType === 'info' ? 'bg-blue-600 border-blue-400 text-white' : 'bg-slate-900 border-slate-700 text-slate-500'}`}>
                        <Star className="w-4 h-4 mb-1" /> <span className="text-[8px] font-bold tracking-tighter">NOTA</span>
                    </button>
                </div>
            )}
          </div>
        </div>

        <div className="flex-1 flex flex-col min-h-[250px] bg-black/30 rounded-xl border border-slate-800 overflow-hidden mb-6">
          <div className="p-3 bg-slate-800/40 border-b border-slate-800 flex justify-between items-center">
             <span className="text-[9px] font-black uppercase text-slate-500 tracking-widest">Puntos en Sesión</span>
             <button onClick={() => setMarkers([])} className="p-1 hover:text-red-400 text-slate-500 transition-colors" title="Borrar todo"><Trash2 className="w-3 h-3" /></button>
          </div>
          <div className="flex-1 overflow-y-auto p-3 space-y-2 text-xs custom-scrollbar">
            {markers.length === 0 ? (
              <p className="text-slate-700 italic text-center py-4">Sin puntos marcados</p>
            ) : markers.map((m, idx) => (
                <div key={idx} className="flex items-center gap-2 p-2 bg-slate-800/20 rounded border border-slate-700/30">
                    <span>{m.type === 'city' ? '📍' : m.type === 'monument' ? '🏛️' : '⭐'}</span>
                    <span className="font-bold text-slate-300 truncate">{m.label}</span>
                </div>
            ))}
          </div>
        </div>
      </aside>

      <main className="flex-1 flex flex-col relative min-h-[500px] w-full">
        <div className="flex-1 relative cursor-crosshair">
          {isEngineLoading && !engineError && (
            <div className="absolute inset-0 flex flex-col items-center justify-center bg-slate-950 z-20">
              <Loader2 className="w-10 h-10 text-orange-500 animate-spin mb-4" />
              <p className="text-slate-400 font-medium tracking-wide uppercase text-xs">Iniciando motor...</p>
            </div>
          )}
          
          <div ref={globeContainerRef} className="absolute inset-0 w-full h-full outline-none" />

          {/* MODAL DE NOMBRE PARA MARCADORES */}
          {pendingMarker && (
              <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm">
                  <div className="bg-slate-900 border border-slate-700 p-6 rounded-2xl shadow-2xl w-80">
                      <div className="flex justify-between items-center mb-4">
                          <h3 className="font-black text-sm flex items-center gap-2 tracking-widest uppercase">
                             {markerType === 'city' ? <MapPin className="text-blue-400 w-4 h-4" /> : markerType === 'monument' ? <Building2 className="text-blue-400 w-4 h-4" /> : <Star className="text-blue-400 w-4 h-4" />}
                             Etiquetar Lugar
                          </h3>
                          <button onClick={() => setPendingMarker(null)}><X className="w-4 h-4 text-slate-500" /></button>
                      </div>
                      <input 
                          autoFocus
                          type="text" 
                          value={markerNameInput}
                          onChange={(e) => setMarkerNameInput(e.target.value)}
                          placeholder="Nombre del lugar..."
                          onKeyDown={(e) => e.key === 'Enter' && saveMarker()}
                          className="w-full bg-slate-950 border border-slate-700 rounded-lg p-3 text-sm outline-none focus:border-blue-500 transition-all mb-4 text-white"
                      />
                      <div className="flex gap-2">
                          <button onClick={() => setPendingMarker(null)} className="flex-1 py-2 rounded-lg bg-slate-800 font-bold text-xs">CANCELAR</button>
                          <button onClick={saveMarker} disabled={!markerNameInput.trim()} className="flex-1 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 text-xs font-black transition-all disabled:opacity-30">GUARDAR</button>
                      </div>
                  </div>
              </div>
          )}
          
          <div className="absolute top-4 right-4 bg-black/60 backdrop-blur-md px-4 py-2 rounded-full text-xs text-slate-300 pointer-events-none flex items-center gap-2 z-10 shadow-lg border border-slate-800">
            <Info className="w-4 h-4 text-orange-400" />
            <span>Arrastra para rotar • Scroll para Zoom</span>
          </div>
        </div>

        <div className="h-40 bg-slate-900 border-t border-slate-800 p-4 overflow-y-auto flex-shrink-0 text-xs text-slate-400 custom-scrollbar">
          <h3 className="text-slate-200 font-semibold mb-3 flex items-center gap-2">
            <Info className="w-4 h-4" /> Ecosistema de Datos y Librerías Externas
          </h3>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <p className="mb-1"><strong className="text-orange-300">Motor Gráfico 3D:</strong> Three.js (v0.146.0) - Renderizado WebGL.</p>
              <p className="mb-1"><strong className="text-orange-300">Visor Esférico:</strong> Globe.gl (v2.27.2) - Envoltorio matemático para la proyección.</p>
              <p><strong className="text-orange-300">Texturas Base:</strong> NASA Blue Marble & Earth Topology.</p>
            </div>
            <div>
              <p className="mb-1"><strong className="text-emerald-300">Vectores Fronterizos:</strong> Natural Earth Data (ne_110m_admin_0_countries & ne_50m_lakes).</p>
              <p className="mb-1"><strong className="text-emerald-300">Vectores de Ríos:</strong> Natural Earth Data (ne_50m_rivers_lake_centerlines).</p>
              <p><strong className="text-emerald-300">Cálculos:</strong> Fórmula de Haversine Matemática.</p>
            </div>
          </div>
        </div>
      </main>

      <style dangerouslySetInnerHTML={{__html: `
        .custom-scrollbar::-webkit-scrollbar { width: 4px; }
        .custom-scrollbar::-webkit-scrollbar-track { background: transparent; }
        .custom-scrollbar::-webkit-scrollbar-thumb { background: rgba(217, 70, 239, 0.2); border-radius: 4px; }
        .custom-scrollbar::-webkit-scrollbar-thumb:hover { background: rgba(217, 70, 239, 0.5); }
      `}} />
    </div>
  );
};

export default App;