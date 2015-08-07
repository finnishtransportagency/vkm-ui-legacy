const Promise = require('bluebird');
const rp = require('request-promise');
const xlsx = require('node-xlsx');
const R = require("ramda");

const API_URL = "http://172.17.118.232/vkm/muunnos";
const GEOCODE_URL = "http://localhost:3000/vkm/geocode";
const REVERSE_GEOCODE_URL = "http://localhost:3000/vkm/reversegeocode";
const HEADERS = ["X", "Y", "Tie", "Tieosa", "Etäisyys", "Ajorata", "Katuosoite", "Kunta"];
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

exports.convert = function(buffer) {
  const worksheet = xlsx.parse(buffer)[0];
  const parsedValues = parseWorksheet(worksheet.data);

  return fillMissingValuesFromBackend(parsedValues).then(buildXlsx(worksheet.name));
}

function fillMissingValuesFromBackend(values) {
  const validCoordinates = R.all(hasAll(COORDINATE_KEYS), values);
  const validAddresses = R.all(hasAll(ADDRESS_KEYS), values);
  const validGeocode = R.all(hasAll(GEOCODE_KEYS), values);

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

function buildXlsx(name) {
  return function(data) {
    const valuesOrderedByKeys = data.map(x => KEYS.map(key => R.prop(key, x)));
    return xlsx.build([{
      name: name,
      data: [HEADERS].concat(valuesOrderedByKeys)
    }]);
  }
}

// parseWorksheet :: [[String]] -> [Object]
//
// > parseWorksheet([["X", "Y"], ["12.34", "45.67"]])
// [{ x: "12.34", y: "45.67" }]
//
// > parseWorksheet([["X", "Y"], ["12.34", "45.67"], ["", ""]])
// [{ x: "12.34", y: "45.67" }]
//
// > parseWorksheet([["12.34", "45.67"]])
// Error
//
// > parseWorksheet([["X", "invalidKey"], ["12.34", "45.67"]])
// Error
//

function parseWorksheet(values) {
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
// > parseWorksheet([["X", "Y"], ["12.34", "45.67"]])
// [{ x: "12.34", y: "45.67" }]
//
// > parseWorksheet([["Tie", "Tieosa", "Etäisyys", "Ajorata"], [4, 117, 4975, 0]])
// [{ tie: 4, osa: 117, etaisyys: 4975, ajorata: 0 }]

function tableToObjects(table) {
  const headersToKeys = R.map((x) => KEYS[HEADERS.indexOf(x)]);

  const headers = R.head(table);
  const content = R.tail(table);

  return R.map(R.zipObj(headersToKeys(headers)), content);
}

const decorateWithAddresses = (coordinates) => decorateWith(LOCALIZED.coordinate, LOCALIZED.address, coordinates);
const decorateWithCoordinates = (addresses) => decorateWith(LOCALIZED.address, LOCALIZED.coordinate, addresses);

function decorateWith(inputType, outputType, values) {
  const payload = R.fromPairs([inputType.plural, values]);
  const data = {
    in: inputType.singular,
    out: outputType.singular,
    callback: null,
    kohdepvm: null,
    json: JSON.stringify(payload)
  };
  return httpPost(API_URL, data).then(
    R.compose(decorate(values), R.prop(outputType.plural), parseJSON)
  );
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
  return Promise.all(geocodes)
    .map(R.compose(R.head, R.prop("results"), parseJSON))
    .then(decorate(values));
}

function httpPost(url, params) {
  return rp.post({ url: url, form: params });
}

function httpGet(url, params) {
  return rp({ url: url, qs: params });
}

function parseJSON(json) {
  return JSON.parse(json);
}

// decorate :: [Object] -> [String] -> [Object]
//
// > decorate([{x: 1, y: 2}])([{tie: 3}])
// [{x: 1, y: 2, tie: 3}]
//
// > decorate([{x: 1, bar: 2}])([{foo: 3}])
// [{x: 1}]
//
// > decorate([{x: 1}])([{x: 2}])
// [{x: 1}]

function decorate(xs) {
  const defaults = R.flip(R.merge);
  const decorateXs = R.zipWith(defaults, xs);
  return R.compose(R.map(R.pick(KEYS)), decorateXs);
}


// hasAll :: [String] -> Object -> Boolean
//
// > hasAll(["foo", "bar"])({foo: 1, bar: 2})
// true
//
// > hasAll(["foo", "bar"])({foo: 1, baz: 2})
// false

function hasAll(properties) {
  return function(obj) {
    return R.all(R.has(R.__, obj), properties);
  }
}
