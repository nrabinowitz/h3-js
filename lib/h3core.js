/*
 * Copyright 2018 Uber Technologies, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *         http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

const C = require('../out/libh3.1');
const BINDINGS = require('./bindings');

const H3 = {};

// Create the bound functions themselves
BINDINGS.forEach(function bind(def) {
    H3[def[0]] = C.cwrap(...def);
});

// Alias the hexidecimal base for legibility
const BASE_16 = 16;

// ----------------------------------------------------------------------------
// Byte size imports

const SZ_INT = 4;
const SZ_PTR = 4;
const SZ_DBL = 8;
const SZ_H3INDEX = H3.sizeOfH3Index();
const SZ_GEOCOORD = H3.sizeOfGeoCoord();
const SZ_GEOBOUNDARY = H3.sizeOfGeoBoundary();
const SZ_GEOPOLYGON = H3.sizeOfGeoPolygon();
const SZ_GEOFENCE = H3.sizeOfGeofence();
const SZ_LINKED_GEOPOLYGON = H3.sizeOfLinkedGeoPolygon();

// ----------------------------------------------------------------------------
// Unit constants
const UNITS = {
    m: 'm',
    km: 'km',
    m2: 'm2',
    km2: 'km2'
};

// ----------------------------------------------------------------------------
// Utilities and helpers

/**
 * Convert degrees to radians
 * @param  {Number} deg Value in degrees
 * @return {Number}     Value in radians
 */
function degsToRads(deg) {
    return (deg * Math.PI) / 180;
}

/**
 * Convert radians to degrees
 * @param  {Number} rad Value in radians
 * @return {Number}     Value in degrees
 */
function radsToDegs(rad) {
    return (rad * 180) / Math.PI;
}

/**
 * Ensure a valid latitude value (core H3 lib will return 0-180)
 * @param  {Number} lat Latitude
 * @return {Number}     Constrained latitude
 */
function constrainLat(lat) {
    return lat > 90 ? lat - 180 : lat;
}

/**
 * Ensure a valid longitude value (core H3 lib will return 0-360)
 * @param  {Number} lat Longitude
 * @return {Number}     Constrained longitude
 */
function constrainLng(lng) {
    return lng > 180 ? lng - 360 : lng;
}

/**
 * Validate a resolution, throwing an error if invalid
 * @param  {mixed} res Value to validate
 * @throws {Error}     Error if invalid
 */
function validateRes(res) {
    if (typeof res !== 'number' || res < 0 || res > 15 || Math.floor(res) !== res) {
        throw new Error(`Invalid resolution: ${res}`);
    }
}

/**
 * Convert an H3 address (64-bit hexidecimal string) into a "split long" - a pair of 32-bit ints
 * @param  {String} h3Address H3 address to check
 * @return {Number[]}         A two-element array with 32 lower bits and 32 upper bits
 */
function h3AddressToSplitLong(h3Address) {
    if (typeof h3Address !== 'string') {
        return [0, 0];
    }
    const upper = parseInt(h3Address.substring(0, h3Address.length - 8), BASE_16);
    const lower = parseInt(h3Address.substring(h3Address.length - 8), BASE_16);
    return [lower, upper];
}

/**
 * Convert a 32-bit int to a hexdecimal string
 * @param  {Number} num Integer to convert
 * @return {String}     Hexidecimal string
 */
function hexFrom32Bit(num) {
    if (num >= 0) {
        return num.toString(BASE_16);
    }

    // Handle negative numbers
    num = num & 0x7fffffff;
    let tempStr = zeroPad(8, num.toString(BASE_16));
    const topNum = (parseInt(tempStr[0], BASE_16) + 8).toString(BASE_16);
    tempStr = topNum + tempStr.substring(1);
    return tempStr;
}

/**
 * Get a H3 address from a split long (pair of 32-bit ints)
 * @param  {Number} lower Lower 32 bits
 * @param  {Number} upper Upper 32 bits
 * @return {String}       H3 address
 */
function splitLongToH3Address(lower, upper) {
    return hexFrom32Bit(upper) + zeroPad(8, hexFrom32Bit(lower));
}

/**
 * Zero-pad a string to a given length
 * @param  {Number} fullLen Target length
 * @param  {String} numStr  String to zero-pad
 * @return {String}         Zero-padded string
 */
function zeroPad(fullLen, numStr) {
    const numZeroes = fullLen - numStr.length;
    let outStr = '';
    for (let i = 0; i < numZeroes; i++) {
        outStr += '0';
    }
    outStr = outStr + numStr;
    return outStr;
}

/**
 * Populate a C-appropriate Geofence struct from a polygon array
 * @param  {Array[]} polygonArray Polygon, as an array of coordinate pairs
 * @param  {Number}  geofence     C pointer to a Geofence struct
 * @param  {Boolean} isGeoJson    Whether coordinates are in [lng, lat] order per GeoJSON spec
 * @return {Number}               C pointer to populated Geofence struct
 */
function polygonArrayToGeofence(polygonArray, geofence, isGeoJson) {
    const numVerts = polygonArray.length;
    const geoCoordArray = C._calloc(numVerts, SZ_GEOCOORD);
    // Support [lng, lat] pairs if GeoJSON is specified
    const latIndex = isGeoJson ? 1 : 0;
    const lngIndex = isGeoJson ? 0 : 1;
    for (let i = 0; i < numVerts * 2; i += 2) {
        C.HEAPF64.set(
            [
                constrainLat(polygonArray[i / 2][latIndex]),
                constrainLng(polygonArray[i / 2][lngIndex])
            ].map(degsToRads),
            geoCoordArray / SZ_DBL + i
        );
    }
    C.HEAPU32.set([numVerts, geoCoordArray], geofence / SZ_INT);
    return geofence;
}

/**
 * Create a C-appropriate GeoPolygon struct from an array of polygons
 * @param  {Array[]} coordinates  Array of polygons, each an array of coordinate pairs
 * @param  {Boolean} isGeoJson    Whether coordinates are in [lng, lat] order per GeoJSON spec
 * @return {Number}               C pointer to populated GeoPolygon struct
 */
function coordinatesToGeoPolygon(coordinates, isGeoJson) {
    // Any loops beyond the first loop are holes
    const numHoles = coordinates.length - 1;
    const geoPolygon = C._calloc(SZ_GEOPOLYGON);
    // Byte positions within the struct
    const geofenceOffset = 0;
    const numHolesOffset = geofenceOffset + SZ_GEOFENCE;
    const holesOffset = numHolesOffset + SZ_INT;
    // geofence is first part of struct
    polygonArrayToGeofence(coordinates[0], geoPolygon + geofenceOffset, isGeoJson);
    let holes;
    if (numHoles > 0) {
        holes = C._calloc(numHoles, SZ_GEOFENCE);
        for (let i = 0; i < numHoles; i++) {
            polygonArrayToGeofence(coordinates[i + 1], holes + SZ_GEOFENCE * i, isGeoJson);
        }
    }
    C.setValue(geoPolygon + numHolesOffset, numHoles, 'i32');
    C.setValue(geoPolygon + holesOffset, holes, 'i32');
    return geoPolygon;
}

/**
 * Free memory allocated for a GeoPolygon struct. It is an error to access the struct
 * after passing it to this method.
 * @return {Number} geoPolygon C pointer to populated GeoPolygon struct
 */
function destroyGeoPolygon(geoPolygon) {
    // Byte positions within the struct
    const geofenceOffset = 0;
    const numHolesOffset = geofenceOffset + SZ_GEOFENCE;
    const holesOffset = numHolesOffset + SZ_INT;
    // Free the outer loop
    C._free(C.getValue(geoPolygon + geofenceOffset, 'i8*'));
    // Free the holes, if any
    const numHoles = C.getValue(geoPolygon + numHolesOffset, 'i32');
    for (let i = 0; i < numHoles; i++) {
        C._free(C.getValue(geoPolygon + holesOffset + SZ_GEOFENCE * i, 'i8*'));
    }
    C._free(geoPolygon);
}

/**
 * Read a long value, returning the lower and upper portions as separate 32-bit integers.
 * Because the upper bits are returned via side effect, the argument to this function is
 * intended to be the invocation that caused the side effect, e.g. readLong(H3.getSomeLong())
 * @param  {Number} invocation Invoked function returning a long value. The actual return
 *                             value of these functions is a 32-bit integer.
 * @return {Number}            Long value as a [lower, upper] pair
 */
function readLong(invocation) {
    // Upper 32-bits of the long set via side-effect
    const upper = C.getTempRet0();
    return [invocation, upper];
}

/**
 * Read an H3 address from a C return value. As with readLong, the argument to this function
 * is intended to be an invocation, e.g. readH3Address(H3.getSomeAddress()), to help ensure that
 * the temp value storing the upper bits of the long is still set.
 * @param  {Number} invocation Invoked function returning a single H3 address
 * @return {String}            H3 address, or null if address was invalid
 */
function readH3Address(invocation) {
    const [lower, upper] = readLong(invocation);
    // The lower bits are allowed to be 0s, but if the upper bits are 0 this represents
    // an invalid H3 address
    return upper ? splitLongToH3Address(lower, upper) : null;
}

/**
 * Read an array of 64-bit H3 addresses from C and convert to a JS array of
 * H3 address strings
 * @param  {Number} cAddress    Pointer to C ouput array
 * @param  {Number} maxCount    Max number of hexagons in array. Hexagons with
 *                              the value 0 will be skipped, so this isn't
 *                              necessarily the length of the output array.
 * @return {String[]}           Array of H3 addresses
 */
function readArrayOfHexagons(cAddress, maxCount) {
    const out = [];
    for (let i = 0; i < maxCount * 2; i += 2) {
        const lower = C.getValue(cAddress + SZ_INT * i, 'i32');
        const upper = C.getValue(cAddress + SZ_INT * (i + 1), 'i32');
        if (lower !== 0 || upper !== 0) {
            out.push(splitLongToH3Address(lower, upper));
        }
    }
    return out;
}

/**
 * Store an array of H3 address strings as a C array of 64-bit integers.
 * @param  {Number} cAddress    Pointer to C input array
 * @param  {String[]} hexagons  H3 addresses to pass to the C lib
 */
function storeArrayOfHexagons(cAddress, hexagons) {
    // Assuming the cAddress points to an already appropriately
    // allocated space
    const count = hexagons.length;
    for (let i = 0; i < count; i++) {
        // HEAPU32 is a typed array projection on the address space
        // as unsigned 32-bit integers. This means the address needs
        // to be divided by 4 to access correctly. Also, the hexagon
        // address is 64-bits, so we skip by twos as we're writing
        // to 32-bit integers in the proper order.
        C.HEAPU32.set(h3AddressToSplitLong(hexagons[i]), cAddress / SZ_INT + 2 * i);
    }
}

function readSingleCoord(cAddress) {
    return radsToDegs(C.getValue(cAddress, 'double'));
}

/**
 * Read a GeoCoord from C and return a [lat, lng] pair.
 * @param  {Number} cAddress    Pointer to C struct
 * @return {Number[]}           [lat, lng] pair
 */
function readGeoCoord(cAddress) {
    return [
        constrainLat(readSingleCoord(cAddress)),
        constrainLng(readSingleCoord(cAddress + SZ_DBL))
    ];
}

/**
 * Read a GeoCoord from C and return a GeoJSON-style [lng, lat] pair.
 * @param  {Number} cAddress    Pointer to C struct
 * @return {Number[]}           [lng, lat] pair
 */
function readGeoCoordGeoJson(cAddress) {
    return [
        constrainLng(readSingleCoord(cAddress + SZ_DBL)),
        constrainLat(readSingleCoord(cAddress))
    ];
}

/**
 * Read the GeoBoundary structure into a list of geo coordinate pairs
 * @param {Number}  geoBoundary     C pointer to GeoBoundary struct
 * @param {Boolean} geoJsonCoords   Whether to provide GeoJSON coordinate order: [lng, lat]
 * @param {Boolean} closedLoop      Whether to close the loop
 * @return {Array[]}                Array of geo coordinate pairs
 */
function readGeoBoundary(geoBoundary, geoJsonCoords, closedLoop) {
    const numVerts = C.getValue(geoBoundary, 'i32');
    // Note that though numVerts is an int, the coordinate doubles have to be
    // aligned to 8 bytes, hence the 8-byte offset here
    const vertsPos = geoBoundary + SZ_DBL;
    const out = [];
    // Support [lng, lat] pairs if GeoJSON is specified
    const readCoord = geoJsonCoords ? readGeoCoordGeoJson : readGeoCoord;
    for (let i = 0; i < numVerts * 2; i += 2) {
        out.push(readCoord(vertsPos + SZ_DBL * i));
    }
    if (closedLoop) {
        // Close loop if GeoJSON is specified
        out.push(out[0]);
    }
    return out;
}

/**
 * Read the LinkedGeoPolygon structure into a nested array of MultiPolygon coordinates
 * @param {Number}  polygon         C pointer to LinkedGeoPolygon struct
 * @param {Boolean} formatAsGeoJson Whether to provide GeoJSON output: [lng, lat], closed loops
 * @return {Array[]}                MultiPolygon-style output.
 */
function readMultiPolygon(polygon, formatAsGeoJson) {
    const output = [];
    const readCoord = formatAsGeoJson ? readGeoCoordGeoJson : readGeoCoord;
    let loops;
    let loop;
    let coords;
    let coord;
    // Loop through the linked structure, building the output
    while (polygon) {
        output.push((loops = []));
        // Follow ->first pointer
        loop = C.getValue(polygon, 'i8*');
        while (loop) {
            loops.push((coords = []));
            // Follow ->first pointer
            coord = C.getValue(loop, 'i8*');
            while (coord) {
                coords.push(readCoord(coord));
                // Follow ->next pointer
                coord = C.getValue(coord + SZ_DBL * 2, 'i8*');
            }
            if (formatAsGeoJson) {
                // Close loop if GeoJSON is requested
                coords.push(coords[0]);
            }
            // Follow ->next pointer
            loop = C.getValue(loop + SZ_PTR * 2, 'i8*');
        }
        // Follow ->next pointer
        polygon = C.getValue(polygon + SZ_PTR * 2, 'i8*');
    }
    return output;
}

// ----------------------------------------------------------------------------
// Public API functions: Core

/**
 * Whether a given string represents a valid H3 address
 * @param  {String} h3Address H3 address to check
 * @return {Boolean}          Whether the address is valid
 */
function h3IsValid(h3Address) {
    const [lower, upper] = h3AddressToSplitLong(h3Address);
    return Boolean(H3.h3IsValid(lower, upper));
}

/**
 * Whether the given H3 address is a pentagon
 * @param  {String} h3Address H3 address to check
 * @return {Boolean}          isPentagon
 */
function h3IsPentagon(h3Address) {
    const [lower, upper] = h3AddressToSplitLong(h3Address);
    return Boolean(H3.h3IsPentagon(lower, upper));
}

/**
 * Whether the given H3 address is in a Class III resolution (rotated versus
 * the icosahedron and subject to shape distortion adding extra points on
 * icosahedron edges, making them not true hexagons).
 * @param  {String} h3Address H3 address to check
 * @return {Boolean}          isResClassIII
 */
function h3IsResClassIII(h3Address) {
    const [lower, upper] = h3AddressToSplitLong(h3Address);
    return Boolean(H3.h3IsResClassIII(lower, upper));
}

/**
 * Get the number of the base cell for a given H3 index
 * @param  {String} h3Address H3 address to get the base cell for
 * @return {Number}           Index of the base cell (0-121)
 */
function h3GetBaseCell(h3Address) {
    const [lower, upper] = h3AddressToSplitLong(h3Address);
    return H3.h3GetBaseCell(lower, upper);
}

/**
 * Returns the resolution of an H3 address
 * @param  {String} h3Address H3 address to get resolution
 * @return {Integer}          The number (0-15) resolution, or -1 if invalid
 */
function h3GetResolution(h3Address) {
    if (typeof h3Address !== 'string') {
        return -1;
    }
    return parseInt(h3Address.charAt(1), BASE_16);
}

/**
 * Get the hexagon containing a lat,lon point
 * @param  {Number} lat Latitude of point
 * @param  {Number} lng Longtitude of point
 * @param  {Number} res Resolution of hexagons to return
 * @return {String}     H3 address
 */
function geoToH3(lat, lng, res) {
    lat = constrainLat(lat);
    lng = constrainLng(lng);
    const latlng = C._malloc(SZ_GEOCOORD);
    // Slightly more efficient way to set the memory
    C.HEAPF64.set([lat, lng].map(degsToRads), latlng / SZ_DBL);
    // Read value as a split long
    const h3Address = readH3Address(H3.geoToH3(latlng, res));
    C._free(latlng);
    return h3Address;
}

/**
 * Get the lat,lon center of a given hexagon
 * @param  {String} h3Address H3 address
 * @return {Number[]}         Point as a [lat, lng] pair
 */
function h3ToGeo(h3Address) {
    const latlng = C._malloc(SZ_GEOCOORD);
    const [lower, upper] = h3AddressToSplitLong(h3Address);
    H3.h3ToGeo(lower, upper, latlng);
    const out = readGeoCoord(latlng);
    C._free(latlng);
    return out;
}

/**
 * Get the vertices of a given hexagon (or pentagon), as an array of [lat, lng]
 * points. For pentagons and hexagons on the edge of an icosahedron face, this
 * function may return up to 10 vertices.
 * @param  {String} h3Address       H3 address
 * @param {Boolean} formatAsGeoJson Whether to provide GeoJSON output: [lng, lat], closed loops
 * @return {Array[]}                Array of [lat, lng] pairs
 */
function h3ToGeoBoundary(h3Address, formatAsGeoJson) {
    const geoBoundary = C._malloc(SZ_GEOBOUNDARY);
    const [lower, upper] = h3AddressToSplitLong(h3Address);
    H3.h3ToGeoBoundary(lower, upper, geoBoundary);
    const out = readGeoBoundary(geoBoundary, formatAsGeoJson, formatAsGeoJson);
    C._free(geoBoundary);
    return out;
}

// ----------------------------------------------------------------------------
// Public API functions: Algorithms

/**
 * Get the parent of the given hexagon at a particular resolution
 * @param  {String} h3Address H3 address to get parent for
 * @param  {Number} res       Resolution of hexagon to return
 * @return {String}           H3 address of parent, or null for invalid input
 */
function h3ToParent(h3Address, res) {
    const [lower, upper] = h3AddressToSplitLong(h3Address);
    return readH3Address(H3.h3ToParent(lower, upper, res));
}

/**
 * Get the children/descendents of the given hexagon at a particular resolution
 * @param  {String} h3Address H3 address to get children for
 * @param  {Number} res       Resolution of hexagons to return
 * @return {String[]}         H3 addresses of children, or empty array for invalid input
 */
function h3ToChildren(h3Address, res) {
    const [lower, upper] = h3AddressToSplitLong(h3Address);
    const maxCount = H3.maxH3ToChildrenSize(lower, upper, res);
    const hexagons = C._calloc(maxCount, SZ_H3INDEX);
    H3.h3ToChildren(lower, upper, res, hexagons);
    const out = readArrayOfHexagons(hexagons, maxCount);
    C._free(hexagons);
    return out;
}

/**
 * Get all hexagons in a k-ring around a given center. The order of the hexagons is undefined.
 * @param  {String} h3Address H3 address of center hexagon
 * @param  {String} ringSize  Radius of k-ring
 * @return {String[]}         H3 addresses for all hexagons in ring
 */
function kRing(h3Address, ringSize) {
    const [lower, upper] = h3AddressToSplitLong(h3Address);
    const maxCount = H3.maxKringSize(ringSize);
    const hexagons = C._calloc(maxCount, SZ_H3INDEX);
    H3.kRing(lower, upper, ringSize, hexagons);
    const out = readArrayOfHexagons(hexagons, maxCount);
    C._free(hexagons);
    return out;
}

/**
 * Get all hexagons in a k-ring around a given center, in an array of arrays
 * ordered by distance from the origin. The order of the hexagons within each ring is undefined.
 *
 * @param  {String} h3Address H3 address of center hexagon
 * @param  {String} ringSize  Radius of k-ring
 * @return {String[][]}       Array of arrays with H3 addresses for all hexagons each ring
 */
function kRingDistances(h3Address, ringSize) {
    const [lower, upper] = h3AddressToSplitLong(h3Address);
    const maxCount = H3.maxKringSize(ringSize);
    const kRings = C._calloc(maxCount, SZ_H3INDEX);
    const distances = C._calloc(maxCount, SZ_INT);
    H3.kRingDistances(lower, upper, ringSize, kRings, distances);
    // Create an array of empty arrays to hold the output
    const out = [];
    for (let i = 0; i < ringSize + 1; i++) {
        out.push([]);
    }
    // Read the array of hexagons, putting them into the appropriate rings
    for (let i = 0; i < maxCount * 2; i += 2) {
        const hexLower = C.getValue(kRings + SZ_INT * i, 'i32');
        const hexUpper = C.getValue(kRings + SZ_INT * (i + 1), 'i32');
        const index = C.getValue(distances + SZ_INT * (i / 2), 'i32');
        if (hexLower !== 0 || hexUpper !== 0) {
            out[index].push(splitLongToH3Address(hexLower, hexUpper));
        }
    }
    C._free(kRings);
    C._free(distances);
    return out;
}

/**
 * Get all hexagons in a hollow hexagonal ring centered at origin with sides of a given length.
 * Unlike kRing, this function will throw an error if there is a pentagon anywhere in the ring.
 * @param  {String} h3Address H3 address of center hexagon
 * @param  {String} ringSize  Radius of ring
 * @return {String[]}         H3 addresses for all hexagons in ring
 */
function hexRing(h3Address, ringSize) {
    const maxCount = ringSize === 0 ? 1 : 6 * ringSize;
    const hexagons = C._calloc(maxCount, SZ_H3INDEX);
    const retVal = H3.hexRing(...h3AddressToSplitLong(h3Address), ringSize, hexagons);
    if (retVal !== 0) {
        C._free(hexagons);
        throw new Error('Failed to get hexRing (encountered a pentagon?)');
    }
    const out = readArrayOfHexagons(hexagons, maxCount);
    C._free(hexagons);
    return out;
}

/**
 * Get all hexagons with centers contained in a given polygon. The polygon
 * is specified with GeoJson semantics as an array of loops. Each loop is
 * an array of [lat, lng] pairs (or [lng, lat] if isGeoJson is specified).
 * The first loop is the perimeter of the polygon, and subsequent loops are
 * expected to be holes.
 * @param  {Array[]}  coordinates   Array of loops, or a single loop
 * @param  {Number} res             Resolution of hexagons to return
 * @param  {Boolean} isGeoJson      Whether to expect GeoJson-style [lng, lat]
 *                                  pairs instead of [lat, lng]
 * @return {String[]}               H3 addresses for all hexagons in polygon
 */
function polyfill(coordinates, res, isGeoJson) {
    validateRes(res);
    isGeoJson = Boolean(isGeoJson);
    // Guard against empty input
    if (coordinates.length === 0 || coordinates[0].length === 0) {
        return [];
    }
    // Wrap to expected format if a single loop is provided
    if (typeof coordinates[0][0] === 'number') {
        coordinates = [coordinates];
    }
    const geoPolygon = coordinatesToGeoPolygon(coordinates, isGeoJson);
    const arrayLen = H3.maxPolyfillSize(geoPolygon, res);
    const hexagons = C._calloc(arrayLen, SZ_H3INDEX);
    H3.polyfill(geoPolygon, res, hexagons);
    const out = readArrayOfHexagons(hexagons, arrayLen);
    C._free(hexagons);
    destroyGeoPolygon(geoPolygon);
    return out;
}

/**
 * Get the outlines of a set of H3 hexagons, returned in GeoJSON MultiPolygon
 * format (an array of polygons, each with an array of loops, each an array of
 * coordinates). Coordinates are returned as [lat, lng] pairs unless GeoJSON
 * is requested.
 * @param {String[]} h3Addresses H3 addresses to get outlines for
 * @param {Boolean}  formatAsGeoJson Whether to provide GeoJSON output: [lng, lat], closed loops
 * @return {Array[]}        MultiPolygon-style output.
 */
function h3SetToMultiPolygon(h3Addresses, formatAsGeoJson) {
    // Early exit on empty input
    if (!h3Addresses || !h3Addresses.length) {
        return [];
    }
    // Set up input set
    const addressCount = h3Addresses.length;
    const set = C._calloc(addressCount, SZ_H3INDEX);
    storeArrayOfHexagons(set, h3Addresses);
    // Allocate memory for output linked polygon
    const polygon = C._calloc(SZ_LINKED_GEOPOLYGON);
    // Store a reference to the first polygon - that's the one we need for
    // memory deallocation
    const originalPolygon = polygon;
    H3.h3SetToLinkedGeo(set, addressCount, polygon);
    const multiPolygon = readMultiPolygon(polygon, formatAsGeoJson);
    // Clean up
    H3.destroyLinkedPolygon(originalPolygon);
    C._free(originalPolygon);
    C._free(set);
    return multiPolygon;
}

/**
 * Compact a set of hexagons of the same resolution into a set of hexagons across
 * multiple levels that represents the same area.
 * @param  {String[]} h3Set H3 addresses to compact
 * @return {$tring[]}       Compacted H3 addresses
 * @throws if there is a malformed input
 */
function compact(h3Set) {
    if (!h3Set || !h3Set.length) {
        return [];
    }
    // Set up input set
    const count = h3Set.length;
    const set = C._calloc(count, SZ_H3INDEX);
    storeArrayOfHexagons(set, h3Set);
    // Allocate memory for compacted hexagons, worst-case is no compaction
    const compactedSet = C._calloc(count, SZ_H3INDEX);
    const retVal = H3.compact(set, compactedSet, count);
    if (retVal !== 0) {
        C._free(set);
        C._free(compactedSet);
        throw new Error('Failed to compact, malformed input data (duplicate hexagons?)');
    }
    const out = readArrayOfHexagons(compactedSet, count);
    C._free(set);
    C._free(compactedSet);
    return out;
}

/**
 * Uncompact a compacted set of hexagons to hexagons of the same resolution
 * @param  {String[]} compactedSet H3 addresses to uncompact
 * @param  {Number}   res          The resolution to uncompact to
 * @return {String[]}              The uncompacted H3 addresses
 * @throws if there is malformed input
 */
function uncompact(compactedSet, res) {
    validateRes(res);
    if (!compactedSet || !compactedSet.length) {
        return [];
    }
    // Set up input set
    const count = compactedSet.length;
    const set = C._calloc(count, SZ_H3INDEX);
    storeArrayOfHexagons(set, compactedSet);
    // Estimate how many hexagons we need (always overestimates if in error)
    const maxUncompactedNum = H3.maxUncompactSize(set, count, res);
    // Allocate memory for uncompacted hexagons
    const uncompactedSet = C._calloc(maxUncompactedNum, SZ_H3INDEX);
    const retVal = H3.uncompact(set, count, uncompactedSet, maxUncompactedNum, res);
    if (retVal !== 0) {
        C._free(set);
        C._free(uncompactedSet);
        throw new Error('Failed to uncompact (bad resolution?)');
    }
    const out = readArrayOfHexagons(uncompactedSet, maxUncompactedNum);
    C._free(set);
    C._free(uncompactedSet);
    return out;
}

// ----------------------------------------------------------------------------
// Public API functions: Unidirectional edges

/**
 * Whether two H3 addresses are neighbors (share an edge)
 * @param  {String} origin      Origin hexagon address
 * @param  {String} destination Destination hexagon address
 * @return {Boolean}           Whether the hexagons share an edge
 */
function h3IndexesAreNeighbors(origin, destination) {
    const [oLower, oUpper] = h3AddressToSplitLong(origin);
    const [dLower, dUpper] = h3AddressToSplitLong(destination);
    return Boolean(H3.h3IndexesAreNeighbors(oLower, oUpper, dLower, dUpper));
}

/**
 * Get an H3 index representing a unidirectional edge for a given origin and destination
 * @param  {String} origin      Origin hexagon address
 * @param  {String} destination Destination hexagon address
 * @return {String}             H3 address of the edge, or null if no edge is shared
 */
function getH3UnidirectionalEdge(origin, destination) {
    const [oLower, oUpper] = h3AddressToSplitLong(origin);
    const [dLower, dUpper] = h3AddressToSplitLong(destination);
    return readH3Address(H3.getH3UnidirectionalEdge(oLower, oUpper, dLower, dUpper));
}

/**
 * Get the origin hexagon from an H3 address representing a unidirectional edge
 * @param  {String} edgeAddress H3 address of the edge
 * @return {String}             H3 address of the edge origin
 */
function getOriginH3IndexFromUnidirectionalEdge(edgeAddress) {
    const [lower, upper] = h3AddressToSplitLong(edgeAddress);
    return readH3Address(H3.getOriginH3IndexFromUnidirectionalEdge(lower, upper));
}

/**
 * Get the destination hexagon from an H3 address representing a unidirectional edge
 * @param  {String} edgeAddress H3 address of the edge
 * @return {String}             H3 address of the edge destination
 */
function getDestinationH3IndexFromUnidirectionalEdge(edgeAddress) {
    const [lower, upper] = h3AddressToSplitLong(edgeAddress);
    return readH3Address(H3.getDestinationH3IndexFromUnidirectionalEdge(lower, upper));
}

/**
 * Whether the input is a valid unidirectional edge
 * @param  {String} edgeAddress H3 address of the edge
 * @return {Boolean}            Whether the address is valid
 */
function h3UnidirectionalEdgeIsValid(edgeAddress) {
    const [lower, upper] = h3AddressToSplitLong(edgeAddress);
    return Boolean(H3.h3UnidirectionalEdgeIsValid(lower, upper));
}

/**
 * Get the [origin, destination] pair represented by a unidirectional edge
 * @param  {String} edgeAddress H3 address of the edge
 * @return {String[]}           [origin, destination] pair as H3 addresses
 */
function getH3IndexesFromUnidirectionalEdge(edgeAddress) {
    const [lower, upper] = h3AddressToSplitLong(edgeAddress);
    const count = 2;
    const hexagons = C._calloc(count, SZ_H3INDEX);
    H3.getH3IndexesFromUnidirectionalEdge(lower, upper, hexagons);
    const out = readArrayOfHexagons(hexagons, count);
    C._free(hexagons);
    return out;
}

/**
 * Get all of the unidirectional edges with the given H3 index as the origin (i.e. an edge to
 * every neighbor)
 * @param  {String} h3Address   H3 address of the origin hexagon
 * @return {String[]}           List of unidirectional edges
 */
function getH3UnidirectionalEdgesFromHexagon(h3Address) {
    const [lower, upper] = h3AddressToSplitLong(h3Address);
    const count = 6;
    const edges = C._calloc(count, SZ_H3INDEX);
    H3.getH3UnidirectionalEdgesFromHexagon(lower, upper, edges);
    const out = readArrayOfHexagons(edges, count);
    C._free(edges);
    return out;
}

/**
 * Get the vertices of a given edge as an array of [lat, lng] points. Note that for edges that
 * cross the edge of an icosahedron face, this may return 3 coordinates.
 * @param  {String} edgeAddress     H3 address of the edge
 * @param {Boolean} formatAsGeoJson Whether to provide GeoJSON output: [lng, lat]
 * @return {Array[]}                Array of geo coordinate pairs
 */
function getH3UnidirectionalEdgeBoundary(edgeAddress, formatAsGeoJson) {
    const geoBoundary = C._malloc(SZ_GEOBOUNDARY);
    const [lower, upper] = h3AddressToSplitLong(edgeAddress);
    H3.getH3UnidirectionalEdgeBoundary(lower, upper, geoBoundary);
    const out = readGeoBoundary(geoBoundary, formatAsGeoJson);
    C._free(geoBoundary);
    return out;
}

// ----------------------------------------------------------------------------
// Public informational utilities

/**
 * Average hexagon area at a given resolution
 * @param  {Number} res  Hexagon resolution
 * @param  {String} unit Area unit (either UNITS.m2 or UNITS.km2)
 * @return {Number}      Average area
 */
function hexArea(res, unit) {
    validateRes(res);
    switch (unit) {
        case UNITS.m2:
            return H3.hexAreaM2(res);
        case UNITS.km2:
            return H3.hexAreaKm2(res);
        default:
            throw new Error(`Unknown unit: ${unit}`);
    }
}

/**
 * Average hexagon edge length at a given resolution
 * @param  {Number} res  Hexagon resolution
 * @param  {String} unit Area unit (either UNITS.m or UNITS.km)
 * @return {Number}      Average edge length
 */
function edgeLength(res, unit) {
    validateRes(res);
    switch (unit) {
        case UNITS.m:
            return H3.edgeLengthM(res);
        case UNITS.km:
            return H3.edgeLengthKm(res);
        default:
            throw new Error(`Unknown unit: ${unit}`);
    }
}

/**
 * The total count of hexagons in the world at a given resolution. Note that above
 * resolution 8 the exact count cannot be represented in a JavaScript 32-bit number,
 * so consumers should use caution when applying further operations to the output.
 * @param  {Number} res  Hexagon resolution
 * @return {Number}      Count
 */
function numHexagons(res) {
    validateRes(res);
    // Get number as a long value
    const [lower, upper] = readLong(H3.numHexagons(res));
    // If we're using <= 32 bits we can use normal JS numbers
    if (!upper) {
        return lower;
    }
    // Above 32 bit, make a JS number that's correct in order of magnitude
    return upper * Math.pow(2, 32) + lower;
}

// ----------------------------------------------------------------------------
// Export

module.exports = {
    h3IsValid,
    h3IsPentagon,
    h3IsResClassIII,
    h3GetBaseCell,
    h3GetResolution,
    geoToH3,
    h3ToGeo,
    h3ToGeoBoundary,
    h3ToParent,
    h3ToChildren,
    kRing,
    kRingDistances,
    hexRing,
    polyfill,
    h3SetToMultiPolygon,
    compact,
    uncompact,
    h3IndexesAreNeighbors,
    getH3UnidirectionalEdge,
    getOriginH3IndexFromUnidirectionalEdge,
    getDestinationH3IndexFromUnidirectionalEdge,
    h3UnidirectionalEdgeIsValid,
    getH3IndexesFromUnidirectionalEdge,
    getH3UnidirectionalEdgesFromHexagon,
    getH3UnidirectionalEdgeBoundary,
    hexArea,
    edgeLength,
    numHexagons,
    degsToRads,
    radsToDegs,
    UNITS
};
