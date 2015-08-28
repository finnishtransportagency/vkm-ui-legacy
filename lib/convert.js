const Promise = require("bluebird");
const rp = require("request-promise");
const xlsx = require("node-xlsx");
const R = require("ramda");

const API_URL = process.env.VKM_API_URL || "http://10.129.65.37:8997";
const VKM_URL = API_URL + "/vkm/muunnos";
const GEOCODE_URL = API_URL + "/vkm/geocode";
const REVERSE_GEOCODE_URL = API_URL + "/vkm/reversegeocode";
const INTERVAL_ROAD_ADDRESS_URL = API_URL + "/vkm/tieosoite";

const POINT_HEADERS = ["X", "Y", "Tie", "Tieosa", "Etäisyys", "Ajorata", "Katuosoite", "Kunta"];
const INTERVAL_HEADERS = ["Tie", "Tieosa (alkupiste)", "Etäisyys (alkupiste)", "Tieosa (loppupiste)", "Etäisyys (loppupiste)", "Ajorata", "AlkuX", "AlkuY", "LoppuX", "LoppuY"];
const ERROR_HEADER = "Virheviesti";

const COORDINATE_KEYS = ["x", "y"];
const ROAD_ADDRESS_KEYS = ["tie", "osa", "etaisyys", "ajorata"];
const STREET_ADDRESS_KEYS = ["osoite", "kunta"];
const INTERVAL_ROAD_ADDRESS_KEYS = ["tie", "osa", "etaisyys", "losa", "let", "ajorata"];
const INTERVAL_COORDINATE_KEYS = ["alkux", "alkuy", "loppux", "loppuy"];
const EXTERNAL_ERROR_KEYS = ["palautusarvo", "virheteksti"];
const ERROR_KEYS = ["valid", "error"].concat(EXTERNAL_ERROR_KEYS);
const POINT_KEYS = COORDINATE_KEYS.concat(ROAD_ADDRESS_KEYS).concat(STREET_ADDRESS_KEYS);
const INTERVAL_KEYS = INTERVAL_ROAD_ADDRESS_KEYS.concat(INTERVAL_COORDINATE_KEYS);

const LOCALIZED = {
  address: {
    plural: "tieosoitteet",
    singular: "tieosoite"
  },
  coordinate: {
    plural: "koordinaatit",
    singular: "koordinaatti"
  }
};

const MISSING_VALUE_ERROR = "Kohdetta ei löytynyt";

const CONCURRENT_REQUEST_LIMIT = 5;

exports.convert = function(buffer) {
  const parseInput = Promise.method(buffer => xlsx.parse(buffer)[0]);
  const addConvertedValuesAndBuildOutput = (worksheet) =>
    addConvertedValuesIfValid(worksheet.data).then(buildOutput(worksheet.name));

  return parseInput(buffer)
    .catch(_ => Promise.reject(Promise.OperationalError("Parsing input failed")))
    .then(addConvertedValuesAndBuildOutput);
};

function addConvertedValuesIfValid(table) {
  const values = parseTable(table);
  const headerKeys = headersToKeys(table[0]);
  const valid = !R.any(R.isNil, R.flatten(R.map(R.values, values)));

  if (valid) {
    return addConvertedValues(values, headerKeys);
  } else {
    const validate = x => R.any(R.or(R.isNil, R.isEmpty), R.values(x));
    return Promise.reject(Promise.OperationalError(validationError(validate, values)));
  }
}

function addConvertedValues(values, headerKeys) {
  const coordinates = R.equals(headerKeys, COORDINATE_KEYS);
  const roadAddresses = R.equals(headerKeys, ROAD_ADDRESS_KEYS);
  const streetAddresses = R.equals(headerKeys, STREET_ADDRESS_KEYS);
  const intervalStreetAddresses = R.equals(headerKeys, INTERVAL_ROAD_ADDRESS_KEYS);

  const attachType = type => values => ({ type: type, values: values });

  if (coordinates) return addRoadAddresses(values).then(addStreetAddresses).then(attachType("point"));
  if (roadAddresses) return addCoordinates(values).then(addStreetAddresses).then(attachType("point"));
  if (streetAddresses) return addGeocodedCoordinates(values).then(addRoadAddresses).then(attachType("point"));
  if (intervalStreetAddresses) return addIntervalCoordinates(values).then(attachType("interval"));
  return Promise.reject(Promise.OperationalError("No valid headers found"));
}

function buildOutput(fileName) {
  return (data) => {
    const keysAndHeaders = R.prop(data.type, {
      point: { headers: POINT_HEADERS, keys: POINT_KEYS },
      interval: { headers: INTERVAL_HEADERS, keys: INTERVAL_KEYS }
    });
    const keys = keysAndHeaders.keys;
    const headers = keysAndHeaders.headers;

    const values = data.values;
    const metadata = getMetadata(values);
    const valuesOrderedByKeys = values.map(x => {
      const valueOrderedByKeys = keys.map(key => R.prop(key, x));
      return x.valid ? valueOrderedByKeys : valueOrderedByKeys.concat(x.error);
    });

    const headerRow = metadata.errors ? headers.concat(ERROR_HEADER) : headers;
    const table = [headerRow].concat(valuesOrderedByKeys);

    return {
      xlsx: xlsx.build([{name: fileName, data: table }]),
      metadata: metadata
    };
  };
}

function getMetadata(data) {
  const notValid = R.compose(R.not, R.prop("valid"));
  if (R.any(notValid, data)) {
    return validationError(notValid, data);
  } else {
    return { errors: false };
  }
}

function validationError(validationFn, data) {
  const rowOffset = 2;
  return {
    errors: true,
    errorCount: R.filter(validationFn, data).length,
    firstError: R.findIndex(validationFn, data) + rowOffset
  };
}

// parseTable :: [[String]] -> [Object]
//
// > parseTable([["X", "Y"], ["12.34", "45.67"]])
// [{ x: "12.34", y: "45.67" }]
//
// > parseTable([["X", "Y"], ["12.34", "45.67"], ["", ""]])
// [{ x: "12.34", y: "45.67" }]
//
// > parseTable([["12.34", "45.67"]])
// Error
//
// > parseTable([["X", "invalidKey"], ["12.34", "45.67"]])
// Error
//

function parseTable(values) {
  const header = values[0] || [];
  const headerConsistsOf = a => R.all(x => R.contains(x, a), header);
  const headerIsValid = headerConsistsOf(POINT_HEADERS) || headerConsistsOf(INTERVAL_HEADERS);

  if (headerIsValid) {
    const onlyNonEmptyRows = R.reject(R.all(R.isEmpty));
    return tableToObjects(onlyNonEmptyRows(values));
  } else {
    throw Promise.OperationalError("You must specity a header");
  }
}


// tableToObjects :: [[String]] -> [Object]
//
// > tableToObjects([["X", "Y"], ["12.34", "45.67"]])
// [{ x: "12.34", y: "45.67" }]
//
// > tableToObjects([["Tie", "Tieosa", "Etäisyys", "Ajorata"], [4, 117, 4975, 0]])
// [{ tie: 4, osa: 117, etaisyys: 4975, ajorata: 0 }]

function tableToObjects(table) {
  const headers = R.head(table);
  const content = R.tail(table);

  return R.map(R.zipObj(headersToKeys(headers)), content);
}

// headersToKeys :: [String] -> [String]
//
// > headersToKeys(["Etäisyys", "Katuosoite", "Kunta"])
// ["etaisyys", "osoite", "kunta"]

function headersToKeys(headerRow) {
  const headers = R.reject(R.isEmpty, headerRow);
  const allKeys = POINT_KEYS.concat(INTERVAL_KEYS);
  const allHeaders = POINT_HEADERS.concat(INTERVAL_HEADERS);
  return R.map(x => allKeys[allHeaders.indexOf(x)], headers);
}

function addRoadAddresses(coordinates) {
  return decorateWith(LOCALIZED.coordinate, LOCALIZED.address, coordinates, ROAD_ADDRESS_KEYS);
}

function addCoordinates(addresses) {
  return decorateWith(LOCALIZED.address, LOCALIZED.coordinate, addresses, COORDINATE_KEYS);
}

function decorateWith(inputType, outputType, values, whitelistedKeys) {
  const payload = {};
  payload[inputType.plural] = values;
  const data = {
    in: inputType.singular,
    out: outputType.singular,
    callback: null,
    kohdepvm: null,
    json: JSON.stringify(payload)
  };
  return httpPost(VKM_URL, data).then(R.pipe(
        R.propOr(values, outputType.plural),
        R.map(R.pick(whitelistedKeys.concat(ERROR_KEYS))),
        mergeAllWith(values),
        R.map(validate)));
}

function addStreetAddresses(values) {
  const reverseGeocode = value => httpGet(REVERSE_GEOCODE_URL, R.pick(COORDINATE_KEYS, value));
  return Promise.map(values, reverseGeocode, { concurrency: CONCURRENT_REQUEST_LIMIT })
    .map(R.pick(STREET_ADDRESS_KEYS))
    .then(mergeAllWith(values));
}

function addGeocodedCoordinates(values) {
  const propertiesToString = R.compose(R.join(", "), R.values, R.pick(STREET_ADDRESS_KEYS));
  const geocode = value => httpPost(GEOCODE_URL, { address: propertiesToString(value) });
  return Promise.map(values, geocode, { concurrency: CONCURRENT_REQUEST_LIMIT })
    .map(R.pipe(
      R.prop("results"),
      headOr({valid: false, error: MISSING_VALUE_ERROR})))
    .then(mergeAllWith(values));
}

function addIntervalCoordinates(values) {
  const intervalStreetAddress = (value) =>
    httpGet(INTERVAL_ROAD_ADDRESS_URL, R.pick(INTERVAL_ROAD_ADDRESS_KEYS, value))
      .then(response => R.merge(value, getEndpointsFromResponse(response, value.ajorata)));

  return Promise.map(values, intervalStreetAddress, { concurrency: CONCURRENT_REQUEST_LIMIT });
}

function getEndpointsFromResponse(response, lane) {
  const start = R.path(["alkupiste", "tieosoitteet"], response);
  const end = R.path(["loppupiste", "tieosoitteet"], response);

  if (start && end) {
    const laneIndex = R.findIndex(x => x.ajorata === lane || 0);
    const startPoint = R.path([laneIndex(start), "point"], start);
    const endPoint = R.path([laneIndex(end), "point"], end);

    if (startPoint && endPoint) {
      return { alkux: startPoint.x, alkuy: startPoint.y, loppux: endPoint.x, loppuy: endPoint.y, valid: true };
    }
  }
  return { error: response.virhe || MISSING_VALUE_ERROR, valid: false };
}

function httpPost(url, params) {
  return rp.post({
    url: url,
    form: params,
    encoding: "utf-8",
    headers: { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8" }
  }).then(parseJSON);
}

function httpGet(url, params) {
  return rp({ url: url, qs: params }).then(parseJSON);
}

function parseJSON(str) {
  return str.trim() ? JSON.parse(str) : {};
}

// mergeAllWith :: [Object] -> [Object] -> [Object]
//
// > mergeAllWith([{x: 1, y: 2}])([{tie: 3}])
// [{x: 1, y: 2, tie: 3}]
//
// > mergeAllWith([{x: 1}])([{x: 2}])
// [{x: 1}]

function mergeAllWith(xs) {
  const defaults = R.flip(R.merge);
  return R.zipWith(defaults, xs);
}

// validate :: Object -> Object
//
// > validate({palautusarvo: 0, virheteksti: "Kohdetta ei löytynyt"})
// {valid: false, error: "Kohdetta ei löytynyt"}
//
// > validate({valid: true, foo: 1})
// {valid: true, foo: 1}

function validate(x) {
  if (R.has("valid", x)) return x;
  const validationStatus = x.palautusarvo === 1 ?
    { valid: true } :
    { valid: false, error: x.virheteksti || MISSING_VALUE_ERROR };
  return R.merge(R.omit(EXTERNAL_ERROR_KEYS, x), validationStatus);
}

// headOr :: a -> [a] -> a
//
// > headOr(1)([2])
// 2
//
// > headOr(1)([])
// 1
function headOr(defaultVal) {
  return function(xs) {
    return xs.length > 0 ? xs[0] : defaultVal;
  };
}
