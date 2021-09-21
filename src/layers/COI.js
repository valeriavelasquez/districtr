
import Filter from "bad-words";
import Tooltip from "../map/Tooltip";
const wordfilter = new Filter();

/**
 * @description Filters user-generated clusters according to specified rules.
 * @param {Object[]} clusters Array of cluster tilesets/assignments/whatever they are.
 * @returns {Object[]} Filtered clusters.
 */
function filterCOIs(clusters) {
    // Set a list of rules (anonymous functions) each COI must abide by to be
    // displayed. Cast things to Booleans for consistency.
    let rules = [
            coi => Boolean(coi.plan),
            coi => Boolean(coi.plan.assignment)
        ],
        filterer = cluster => {
            for (let rule of rules) if (!rule(cluster)) return false;
            return true;
        };

    // If *any* of the rules fail, the COI can't be included. Otherwise, include
    // the COI.
    return clusters.filter(filterer);
}

/**
 * @description For each of the clusters and their comprising COIs, get the units they cover.
 * @param {Object[]} clusters List of clusters, defined as Plans.
 * @returns Object COIs and the units they cover; a Set containing unique COI names.
 */
function createUnitMap(clusters) {
    let unitMap = {};
    
    // Create a mapping from cluster IDs to a mapping which takes individual COI
    // names to the units the COI covers, as well as *all* the units the COI
    // covers. I really wish there was a better way to selectively do opacity
    // stuff on things rather than having to re-write the whole fucking style
    // expression -- that's really annoying.
    for (let cluster of clusters) {
        let clusterIdentifier = cluster.plan.id,
            identifiers = {},
            clusterMap = {};

        // Get the names of the clusters so we can re-name later.
        for (let part of cluster.plan.parts) identifiers[part.id] = part.name;

        // For each of the COIs in the cluster, map the *identifier* of the COI
        // to the units it covers. This populates the `clusterMap` object, which
        // we'll be modifying in a moment.
        for (let [unit, coiids] of Object.entries(cluster.plan.assignment)) {
            // Sometimes -- when units belong only to one COI -- the COI identifiers
            // are reported only as integers and *not* lists of integers. Here,
            // we just force them to be lists of numbers.
            if (!Array.isArray(coiids)) coiids = [coiids];

            for (let coiid of coiids) {
                let name = identifiers[coiid];
                if (clusterMap[name]) clusterMap[name].push(unit);
                else clusterMap[name] = [unit];
            }
        }

        unitMap[clusterIdentifier] = clusterMap;
    }

    // Return the summed object and the unique names accompanying it.
    return unitMap;
}

/**
 * @description Fetches a JSON file which maps pattern names to filepaths. Needed
 * for assigning COIs to patterns.
 * @returns {Promise} Promise which gets the locally-defined patterns.
 */
function loadPatternMapping() {
    return fetch("/assets/patterns/patterns.json").then(res => res.json());
}

/**
 * @description Loads the desired patterns.
 * @param {mapboxgl.Map} map Map object to which we're adding patterns.
 * @param {Object} patternMapping Maps pattern names to URLs.
 * @returns Promise When each of the Promises in the provided iterable have
 * resovled or rejected, returns an array of pattern names (or "transparent" if
 * the Promise couldn't be resolved).
 */
function loadPatterns(map, patternMapping) {
    // Create an array which we'll fill with Promises.
    let patternLoadingPromises = [];

    // For each pattern and its corresponding URL, attempt to load the image
    // into mapbox. Once the image is loaded, return the name of the pattern to
    // the caller as a Promise.
    for (let [pattern, url] of Object.entries(patternMapping)) {
        patternLoadingPromises.push(
            new Promise((resolve, reject) => {
                map.loadImage(url, (error, image) => {
                    // If we encounter an error, the pattern won't load. Even though
                    // this violates a linting rule -- because we aren't rejecting
                    // with an error -- that's the point: any pattern whose image
                    // can't be loaded should become transparent.
                    if (error) reject("transparent");

                    // Otherwise, add the pattern to the map, and it's ready for
                    // assignment!
                    map.addImage(pattern, image);
                    resolve(pattern);
                });
            })
        );
    }

    return Promise.allSettled(patternLoadingPromises);
}

/**
 * @description Maps COI names to pattern names so we can easily reference later.
 * @param {unitMap} unitMap Maps cluster names to COI names to units.
 * @param {Object} patterns Patterns we've chosen.
 * @returns Object Takes COI names to pattern names.
 */
function patternsToCOIs(unitMap, patterns) {
    let mapping = {};

    for (let [clusterIdentifier, cluster] of Object.entries(unitMap)) {
        // Create an empty mapping for the *cluster* into which we can assign
        // patterns for the individual COIs. Then, for each of the individual
        // COIs, assign to it the first pattern in the list of patterns.
        mapping[clusterIdentifier] = {};

        for (let coiIdentifier of Object.keys(cluster)) {
            mapping[clusterIdentifier][coiIdentifier] = patterns.shift();
        }
    }
    return mapping;
}

/**
 * @description Removes properties from `object` not specified in `included`.
 * @param {Object} object Object to have properties removed.
 * @param {Array} included Properties retained.
 * @returns Object
 */
function include(object, included) {
    return Object.fromEntries(
        Object
            .entries(object)
            .filter(([key]) => included.includes(key))
    );
}

/**
 * @description Takes the results from Promise.allSettled() and makes them into
 * an array that's easier to handle.
 * @param {Object[]} results Resolved or rejected Promise results.
 * @returns Object[]
 */
function resolvesToArray(results) {
    let values = [];
    for (let result of results) values.push(result.value);
    return Promise.resolve(values);
}

export function opacityStyleExpression(units, geoids, opacity=1/3) {
    // Creat a filter for setting opacities on only the specified units.
    let filter = [
            "case", [
                "in",
                ["get", "GEOID20"],
                ["literal", geoids]
            ],
            0, opacity
        ],
        layer = units.type.replace("symbol", "icon") + "-opacity";
    units.setPaintProperty(layer, filter);
}

/**
 * @description Creates a style expression for the units.
 * @param {Object} units Units we're coloring.
 * @param {Object} unitMap Unit mapping.
 * @param {Object} patternMatch Pattern mapping; just unitMapping, but instead of units, it's pattern names.
 * @returns {Array[]} Array of expressions.
 */
export function patternStyleExpression(units, unitMap, patternMatch) {
    let expression = ["case"];

    // For each of the clusters and the COIs within that cluster, assign each
    // COI a pattern according 
    for (let [clusterIdentifier, cluster] of Object.entries(unitMap)) {
        for (let [coiName, geoids] of Object.entries(cluster)) {
            let subexpression = [
                "in",
                ["get", "GEOID20"],
                ["literal", geoids]
            ];
            expression.push(subexpression, patternMatch[clusterIdentifier][coiName]);
        }
    }

    // Make the remaining units transparent and enforce the style rule.
    expression.push("transparent");
    units.setPaintProperty("fill-pattern", expression);

    return expression;
}

/**
 * @description Configures COI-related functionality in districting mode.
 * @param {State} state Holds state for the application.
 * @param {Tab} tab Tab object we're adding items to.
 * @returns {Promise} Promise which resolves to the necessary objects for visualizing COIs.
 */
export function addCOIs(state) {
    let { map, coiunits, place } = state,
        localURL = "/assets/sample_module.json",
        remoteURL = `/.netlify/functions/moduleRead?module=${place.id}&state=${place.state}&page=1`,
        URL = window.location.hostname == "localhost" ? localURL : remoteURL;

    // Fetch COI data from the provided URL. Note that in order to return the
    // required data to the caller, we have to return *all* the Promises and
    // their resolutions, not just the first or last ones. This is important, as
    // we don't want to have to recalculate COI-related stuff later.
    return fetch(URL)
        .then(res => res.json())
        .then(clusters => {
            // Filter COI clusters and create a mapping from names to patterns.
            let filtered = filterCOIs(clusters),
                unitMap = createUnitMap(filtered);

            return loadPatternMapping().then(patterns => {
                // Get the total number of COI names.
                let numberOfNames = 0;
                for (let cluster of Object.values(unitMap)) numberOfNames += Object.keys(cluster).length;

                // Now, get the right number of names, pare down the object mapping
                // names to URLs to only contain the desired names, and map COIs
                // to patterns.
                let names = Object.keys(patterns).slice(0, numberOfNames),
                    chosenPatterns = include(patterns, names),
                    patternMatch = patternsToCOIs(unitMap, names);

                // Now, we want to load each of the patterns and assign them to
                // expressions.
                return loadPatterns(map, chosenPatterns)
                    .then(loadedPatterns => resolvesToArray(loadedPatterns))
                    .then(_ => {
                        // For each of the COIs, get the block groups that it
                        // covers and create a mapbox style expression assigning
                        // a pattern overlay to the units.
                        patternStyleExpression(coiunits, unitMap, patternMatch);
                        coiunits.setOpacity(0);

                        // From here, we want to return all the necessary items
                        // for properly rendering the COIs in the tool pane. We
                        // should return the style expression, the unit mapping,
                        // the pattern mapping, and the COIs themselves.
                        return {
                            clusters: clusters,
                            unitMap: unitMap,
                            patternMatch: patternMatch,
                            units: coiunits,
                            chosenPatterns: chosenPatterns
                        };
                    });
            });
        });
}
