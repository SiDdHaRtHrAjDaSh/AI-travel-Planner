import React, { useState, useRef, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { GoogleGenAI, Type } from "@google/genai";

// Fix: Declare the google global to fix TypeScript errors. The Google Maps API is loaded via a script tag.
declare const google: any;

declare global {
  interface Window {
    initMap: () => void;
  }
}

interface Location {
  lat: number;
  lng: number;
  address: string;
}

interface ItineraryStop {
  place_name: string;
  description: string;
  coordinates: {
    latitude: number;
    longitude: number;
  }
}

interface Itinerary {
  summary: string;
  itinerary: ItineraryStop[];
}

interface GroundingChunk {
  web: {
    uri: string;
    title: string;
  }
}

const App: React.FC = () => {
  const [startLocation, setStartLocation] = useState<Location | null>(null);
  const [travelMode, setTravelMode] = useState<string>('DRIVING');
  const [radius, setRadius] = useState<number>(10); // miles
  const [duration, setDuration] = useState<number>(4); // hours
  
  const [itinerary, setItinerary] = useState<Itinerary | null>(null);
  const [sources, setSources] = useState<GroundingChunk[]>([]);
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  const mapRef = useRef<HTMLDivElement>(null);
  // Fix: Use 'any' for Google Maps types to avoid compilation errors.
  const mapInstance = useRef<any | null>(null);
  const markerInstance = useRef<any | null>(null);
  const directionsService = useRef<any | null>(null);
  const directionsRenderer = useRef<any | null>(null);
  const geocoder = useRef<any | null>(null);

  const autocompleteInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    window.initMap = () => {
      if (!mapRef.current) return;
      
      const map = new google.maps.Map(mapRef.current, {
        center: { lat: 34.0522, lng: -118.2437 }, // Default to Los Angeles
        zoom: 8,
        mapId: 'AI_TRAVEL_PLANNER_MAP'
      });
      mapInstance.current = map;
      directionsService.current = new google.maps.DirectionsService();
      geocoder.current = new google.maps.Geocoder();
      directionsRenderer.current = new google.maps.DirectionsRenderer({
        map: map,
        suppressMarkers: true,
      });

      map.addListener('click', handleMapClick);

      if (autocompleteInputRef.current) {
        const autocomplete = new google.maps.places.Autocomplete(autocompleteInputRef.current);
        autocomplete.bindTo('bounds', map);
        autocomplete.addListener('place_changed', () => {
          const place = autocomplete.getPlace();
          if (place.geometry && place.geometry.location) {
              const location = {
                  lat: place.geometry.location.lat(),
                  lng: place.geometry.location.lng(),
                  address: place.formatted_address || "Selected location",
              }
              updateLocation(location);
          }
        });
      }
    };

    if (
      !document.querySelector(
        'script[src^="https://maps.googleapis.com/maps/api/js"]',
      )
    ) {
      const script = document.createElement('script');
      script.src = `https://maps.googleapis.com/maps/api/js?key=${process.env.API_KEY}&libraries=places,marker,routes&callback=initMap`;
      script.async = true;
      script.defer = true;
      document.head.appendChild(script);
    } else if (!mapInstance.current) {
        window.initMap();
    }
  }, []);

  const updateLocation = (location: Location) => {
    setStartLocation(location);
    if(mapInstance.current){
        mapInstance.current.setCenter({ lat: location.lat, lng: location.lng });
        mapInstance.current.setZoom(12);

        if (markerInstance.current) {
            markerInstance.current.position = { lat: location.lat, lng: location.lng };
        } else {
            markerInstance.current = new google.maps.marker.AdvancedMarkerElement({
                position: { lat: location.lat, lng: location.lng },
                map: mapInstance.current,
            });
        }
    }
    if(autocompleteInputRef.current){
        autocompleteInputRef.current.value = location.address;
    }
  }

  // Fix: Use 'any' for Google Maps event type to avoid compilation errors.
  const handleMapClick = async (event: any) => {
    if (event.latLng && geocoder.current) {
        const latLng = event.latLng;
        try {
            const response = await geocoder.current.geocode({ location: latLng });
            if (response.results[0]) {
                const location = {
                    lat: latLng.lat(),
                    lng: latLng.lng(),
                    address: response.results[0].formatted_address,
                }
                updateLocation(location);
            }
        } catch(e) {
            console.error("Geocoder failed due to: " + e);
            const location = {
                lat: latLng.lat(),
                lng: latLng.lng(),
                address: `Lat: ${latLng.lat().toFixed(4)}, Lng: ${latLng.lng().toFixed(4)}`
            }
            updateLocation(location);
        }
    }
  }

  const handleGetCurrentLocation = () => {
    if (!navigator.geolocation) {
      setError("Geolocation is not supported by your browser.");
      return;
    }
    setError(null);
    navigator.geolocation.getCurrentPosition(
      async (position) => {
        const { latitude, longitude } = position.coords;
        try {
          if (geocoder.current) {
            const response = await geocoder.current.geocode({ location: { lat: latitude, lng: longitude } });
            if (response.results[0]) {
              const location = {
                lat: latitude,
                lng: longitude,
                address: response.results[0].formatted_address,
              };
              updateLocation(location);
            } else {
              throw new Error("No address found for coordinates.");
            }
          }
        } catch (e) {
          console.error("Geocoder failed due to: " + e);
          const location = {
            lat: latitude,
            lng: longitude,
            address: `Lat: ${latitude.toFixed(4)}, Lng: ${longitude.toFixed(4)}`,
          };
          updateLocation(location);
        }
      },
      (geoError) => {
        switch (geoError.code) {
          case geoError.PERMISSION_DENIED:
            setError("You denied the request for Geolocation.");
            break;
          case geoError.POSITION_UNAVAILABLE:
            setError("Location information is unavailable.");
            break;
          case geoError.TIMEOUT:
            setError("The request to get user location timed out.");
            break;
          default:
            setError("An unknown error occurred while getting location.");
            break;
        }
      }
    );
  };
  
  const handleGenerateItinerary = async () => {
    if (!startLocation) {
      setError("Please select a starting location first.");
      return;
    }
    setIsLoading(true);
    setError(null);
    setItinerary(null);
    setSources([]);
    if(directionsRenderer.current) {
      directionsRenderer.current.setDirections({routes: []});
    }

    try {
      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
      const prompt = `Create a travel itinerary starting from "${startLocation.address}" (coordinates: lat ${startLocation.lat}, lng ${startLocation.lng}). The user wants to travel by ${travelMode}, staying within a ${radius}-mile radius, for a total trip duration of no more than ${duration} hours. Suggest a few points of interest and a logical route. Respond ONLY with a single JSON object in a markdown code block. The JSON object should have a "summary" key with a short trip description, and an "itinerary" key which is an array of objects. Each object in the array should represent a stop and have "place_name", "description", and "coordinates" (with "latitude" and "longitude") keys.`;
      
      const response = await ai.models.generateContent({
        model: "gemini-2.5-flash",
        contents: prompt,
        config: {
          tools: [{googleSearch: {}}],
        },
      });

      const jsonText = response.text.replace(/^```json\n|```$/g, '').trim();
      const result: Itinerary = JSON.parse(jsonText);
      setItinerary(result);

      if (response.candidates?.[0]?.groundingMetadata?.groundingChunks) {
          setSources(response.candidates[0].groundingMetadata.groundingChunks as GroundingChunk[]);
      }

      if (result.itinerary && result.itinerary.length > 0 && directionsService.current && directionsRenderer.current) {
        // Fix: Use 'any' for Google Maps types to avoid compilation errors.
        const waypoints: any[] = result.itinerary.map(stop => ({
          location: new google.maps.LatLng(stop.coordinates.latitude, stop.coordinates.longitude),
          stopover: true,
        }));

        // Fix: Use 'any' for Google Maps types to avoid compilation errors.
        const request: any = {
          origin: new google.maps.LatLng(startLocation.lat, startLocation.lng),
          destination: waypoints[waypoints.length - 1].location,
          waypoints: waypoints.slice(0, -1),
          travelMode: travelMode,
          optimizeWaypoints: true,
        };
        
        directionsService.current.route(request, (result: any, status: any) => {
          if (status === 'OK' && result && directionsRenderer.current) {
            directionsRenderer.current.setDirections(result);
          } else {
            setError('Failed to calculate directions.');
          }
        });
      }
    } catch (e) {
      console.error(e);
      setError("Failed to generate itinerary. The AI model might have returned an invalid format. Please try again.");
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="app-container">
      <div className="controls-panel">
        <header>
          <h1>AI Travel Planner</h1>
          <p>Enter your preferences and let AI create your next adventure.</p>
        </header>
        <div className="form-section">
          <label htmlFor="address-input">Starting point</label>
          <div className="address-input-container">
            <input ref={autocompleteInputRef} id="address-input" type="text" placeholder="Enter an address or drop a pin on the map" />
            <button className="location-button" onClick={handleGetCurrentLocation} aria-label="Get current location" title="Get current location">
              <svg xmlns="http://www.w3.org/2000/svg" height="24px" viewBox="0 0 24 24" width="24px"><path d="M0 0h24v24H0V0z" fill="none"/><path d="M12 8c-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4-1.79-4-4-4zm8.94 3c-.46-4.17-3.77-7.48-7.94-7.94V1h-2v2.06C6.83 3.52 3.52 6.83 3.06 11H1v2h2.06c.46 4.17 3.77 7.48 7.94 7.94V23h2v-2.06c4.17-.46 7.48-3.77 7.94-7.94H23v-2h-2.06zM12 19c-3.87 0-7-3.13-7-7s3.13-7 7-7 7 3.13 7 7-3.13 7-7 7z"/></svg>
            </button>
          </div>
        </div>
        <div className="form-section">
          <label>Mode of transport</label>
          <div className="transport-options">
            <input type="radio" id="driving" name="transport" value="DRIVING" checked={travelMode === 'DRIVING'} onChange={(e) => setTravelMode(e.target.value)} />
            <label htmlFor="driving">Drive</label>
            <input type="radio" id="walking" name="transport" value="WALKING" checked={travelMode === 'WALKING'} onChange={(e) => setTravelMode(e.target.value)} />
            <label htmlFor="walking">Walk</label>
            <input type="radio" id="bicycling" name="transport" value="BICYCLING" checked={travelMode === 'BICYCLING'} onChange={(e) => setTravelMode(e.target.value)} />
            <label htmlFor="bicycling">Cycle</label>
            <input type="radio" id="transit" name="transport" value="TRANSIT" checked={travelMode === 'TRANSIT'} onChange={(e) => setTravelMode(e.target.value)} />
            <label htmlFor="transit">Transit</label>
          </div>
        </div>
        <div className="form-section">
          <label htmlFor="radius-slider">Radius</label>
          <div className="slider-container">
            <input id="radius-slider" type="range" min="1" max="100" value={radius} onChange={(e) => setRadius(Number(e.target.value))} />
            <span>{radius} miles</span>
          </div>
        </div>
        <div className="form-section">
          <label htmlFor="duration-slider">Max hours</label>
           <div className="slider-container">
            <input id="duration-slider" type="range" min="1" max="24" value={duration} onChange={(e) => setDuration(Number(e.target.value))} />
            <span>{duration} hours</span>
          </div>
        </div>
        <button className="submit-button" onClick={handleGenerateItinerary} disabled={isLoading || !startLocation}>
          {isLoading ? 'Generating...' : 'Generate Itinerary'}
        </button>

        <div className="results-panel">
          {isLoading && <div className="loader"><div className="spinner"></div><span>Planning your trip...</span></div>}
          {error && <div className="error-message">{error}</div>}
          {itinerary && (
            <div className="itinerary-summary">
              <h2>Your Trip Plan</h2>
              <p>{itinerary.summary}</p>
              {itinerary.itinerary.map((stop, index) => (
                <div key={index} className="itinerary-stop">
                  <h3>{index + 1}. {stop.place_name}</h3>
                  <p>{stop.description}</p>
                </div>
              ))}
            </div>
          )}
          {sources.length > 0 && (
            <div className="sources-section">
                <h3>Sources</h3>
                <ul>
                    {sources.map((source, index) => (
                        <li key={index}>
                            <a href={source.web.uri} target="_blank" rel="noopener noreferrer">{source.web.title}</a>
                        </li>
                    ))}
                </ul>
            </div>
          )}
        </div>
      </div>
      <div className="map-panel" ref={mapRef}></div>
    </div>
  );
};

const container = document.getElementById('root');
const root = createRoot(container!);
root.render(<App />);