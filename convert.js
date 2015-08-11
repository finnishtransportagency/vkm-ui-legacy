const Promise = require('bluebird');
const rp = require('request-promise');
const xlsx = require('node-xlsx');
const R = require("ramda");

const API_URL = "http://172.17.118.232/vkm/muunnos";
const GEOCODE_URL = "http://localhost:3000/vkm/geocode";
const REVERSE_GEOCODE_URL = "http://localhost:3000/vkm/reversegeocode";
const HEADERS = ["X", "Y", "Tie", "Tieosa", "Etäisyys", "Ajorata", "Katuosoite", "Kunta"];
const ERROR_HEADER = "Virheviesti";
const COORDINATE_KEYS = ["x", "y"];
const ADDRESS_KEYS = ["tie", "osa", "etaisyys", "ajorata"];
const GEOCODE_KEYS = ["osoite", "kunta"];
const KEYS = COORDINATE_KEYS.concat(ADDRESS_KEYS).concat(GEOCODE_KEYS);
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

exports.convert = function(buffer) {
  const worksheet = xlsx.parse(buffer)[0];

  return fillMissingValuesFromBackend(worksheet.data)
    .then(buildOutput(worksheet.name));
}

function fillMissingValuesFromBackend(table) {
  const nonEmpty = R.reject(R.isEmpty);
  const headerKeys = headersToKeys(nonEmpty(table[0]));

  const validCoordinates = R.equals(headerKeys, COORDINATE_KEYS);
  const validAddresses = R.equals(headerKeys, ADDRESS_KEYS);
  const validGeocode = R.equals(headerKeys, GEOCODE_KEYS);

  const values = parseTable(table);
  if (validCoordinates) {
    return decorateWithAddresses(values)
      .then(decorateWithReverseGeocode);
  } else if (validAddresses) {
    return decorateWithCoordinates(values)
      .then(decorateWithReverseGeocode);
  } else if (validGeocode) {
    return decorateWithGeocode(values)
      .then(decorateWithAddresses);
  } else {
    return new Promise((_, reject) => reject("Parsing failed"));
  }
}

function buildOutput(fileName) {
  return function(data) {
    const metadata = getMetadata(data);
    const valuesOrderedByKeys = data.map(x => {
      const valueOrderedByKeys = KEYS.map(key => R.prop(key, x));
      return x.valid ? valueOrderedByKeys : valueOrderedByKeys.concat(x.error);
    });
    const headerRow = metadata.errors ? HEADERS.concat(ERROR_HEADER) : HEADERS;
    const table = [headerRow].concat(valuesOrderedByKeys);
    return {
      xlsx: xlsx.build([{name: fileName, data: table }]),
      metadata: metadata
    };
  }
}

function getMetadata(data) {
  const notValid = R.compose(R.not, R.prop("valid"));
  if (R.any(notValid, data)) {
    const rowOffset = 2;
    return {
      errors: true,
      errorCount: R.filter(notValid, data).length,
      firstError: R.findIndex(notValid, data) + rowOffset
    }
  } else {
    return {
      errors: false
    };
  }
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
  const hasHeader = (x) => R.all(R.contains(R.__, HEADERS))(x[0]);
  const onlyNonEmptyRows = R.reject(R.all(R.isEmpty));

  if (hasHeader(values)) {
    return tableToObjects(onlyNonEmptyRows(values));
  } else {
    throw new Error("You must specity a header");
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
// > headersToKeys(['Etäisyys', 'Katuosoite', 'Kunta'])
// ['etaisyys', 'osoite', 'kunta']

const headersToKeys = R.map((x) => KEYS[HEADERS.indexOf(x)]);

const decorateWithAddresses = (coordinates) => decorateWith(LOCALIZED.coordinate, LOCALIZED.address, coordinates);
const decorateWithCoordinates = (addresses) => decorateWith(LOCALIZED.address, LOCALIZED.coordinate, addresses);

function decorateWith(inputType, outputType, values) {
  const payload = {};
  payload[inputType.plural] = values;
  const data = {
    in: inputType.singular,
    out: outputType.singular,
    callback: null,
    kohdepvm: null,
    json: JSON.stringify(payload)
  };
  const parse = R.compose(decorate(values), R.propOr([], outputType.plural), parseJSON);
  return httpPost(API_URL, data).then(parse).map(validate);
}

function decorateWithReverseGeocode(values) {
  const createQueryParams = R.compose(R.join(", "), R.values, R.pick(GEOCODE_KEYS));
  const reverseGeocodes = values.map((value) => httpGet(REVERSE_GEOCODE_URL, { address: createQueryParams(value) }));
  return Promise.all(reverseGeocodes)
    .map(parseJSON)
    .then(decorate(values));
}

function decorateWithGeocode(values) {
  const geocodes = values.map((value) => httpGet(GEOCODE_URL, R.pick(COORDINATE_KEYS, value)));
  const parse = R.compose(headOr({valid: false, error: MISSING_VALUE_ERROR}), R.prop("results"), parseJSON);
  return Promise.all(geocodes)
    .map(parse)
    .then(decorate(values));
}

function httpPost(url, params) {
  return rp.post({ url: url, form: params, encoding: 'binary' });
}

function httpGet(url, params) {
  return rp({ url: url, qs: params });
}

function parseJSON(json) {
  return json ? JSON.parse(json) : {};
}

// decorate :: [Object] -> [String] -> [Object]
//
// > decorate([{x: 1, y: 2}])([{tie: 3}])
// [{x: 1, y: 2, tie: 3}]
//
// > decorate([{x: 1}])([{x: 2}])
// [{x: 1}]

function decorate(xs) {
  const defaults = R.flip(R.merge);
  return R.zipWith(defaults, xs);
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
  }
}


// validate :: Object -> Object
//
// > validate({palautusarvo: 0, virheteksti: "Kohdetta ei löytynyt"})
// {valid: false, error: "Kohdetta ei löytynyt"}
//
function validate(x) {
  const validationStatus = x.palautusarvo === 1 ? { valid: true } : { valid: false, error: x.virheteksti };
  return R.merge(R.omit(['palautusarvo', 'virheteksti'], x), validationStatus);
}
