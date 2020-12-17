const Promise = require("bluebird");
const rp = require("request-promise");
const xlsx = require("node-xlsx");
const R = require("ramda");

//const API_URL = "http://localhost:8889";
//const VKM_URL = API_URL + "/vkm-api/muunna";

const API_URL = "https://kehitysjulkinen.vayla.fi";
const VKM_URL = API_URL + "/viitekehysmuunnin/muunna";

//const POINT_HEADERS = ["X", "Y", "Tie", "Ajorata", "Tieosa", "Etäisyys", "Katuosoite", "Kunta", "Ely", "Urakka-alue"];
const POINT_HEADERS = ["X", "Y", "Tie", "Ajorata", "Tieosa", "Etäisyys", "Katunimi", "Katunumero", "Kunta", "Ely", "Urakka-alue"];
const POINT_DAYS_HEADERS = ["Tie", "Ajorata", "Tieosa", "Etäisyys", "Tilannepvm", "Kohdepvm", "Tie output", "Ajorata output", "Tieosa output", "Etäisyys output"];
const INTERVAL_HEADERS = ["Tie", "Ajorata", "Tieosa (alkupiste)", "Etäisyys (alkupiste)", "Tieosa (loppupiste)", "Etäisyys (loppupiste)", "AlkuX", "AlkuY", "LoppuX", "LoppuY"];
const ERROR_HEADER = "Virheviesti";

const COORDINATE_KEYS = ["x", "y"];
const ROAD_ADDRESS_KEYS = ["tie", "ajorata", "osa", "etaisyys"];
const ROAD_ADDRESS_KEYS_OUT = ["tie_out", "ajorata_out", "osa_out", "etaisyys_out"];
//const STREET_ADDRESS_KEYS = ["osoite", "kunta"];
const STREET_ADDRESS_KEYS = ["katunimi", "katunumero", "kuntanimi"];
//const OTHER_ADDRESS_KEYS = ["ely", "urakka_alue"];
const OTHER_ADDRESS_KEYS = ["ely", "ualue"];
const OTHER_DAYS_KEYS = ["tilannepvm","kohdepvm"];
//const INTERVAL_ROAD_ADDRESS_KEYS = ["tie", "ajorata", "osa", "etaisyys", "losa", "let"];
const INTERVAL_ROAD_ADDRESS_KEYS = ["tie", "ajorata", "osa", "etaisyys", "osa_loppu", "etaisyys_loppu"];
//const INTERVAL_COORDINATE_KEYS = ["alkux", "alkuy", "loppux", "loppuy"];
const INTERVAL_COORDINATE_KEYS = ["x", "y", "x_loppu", "y_loppu"];
//const EXTERNAL_ERROR_KEYS = ["palautusarvo", "virheteksti"];
const EXTERNAL_ERROR_KEYS = ["virheet"];

const ERROR_KEYS = ["valid", "error"].concat(EXTERNAL_ERROR_KEYS);
const POINT_KEYS = COORDINATE_KEYS.concat(ROAD_ADDRESS_KEYS).concat(STREET_ADDRESS_KEYS).concat(OTHER_ADDRESS_KEYS);
const INTERVAL_KEYS = INTERVAL_ROAD_ADDRESS_KEYS.concat(INTERVAL_COORDINATE_KEYS);
const POINT_DAYS_KEYS = ROAD_ADDRESS_KEYS.concat(OTHER_DAYS_KEYS).concat(ROAD_ADDRESS_KEYS_OUT);
const OPTIONAL_INTERVAL_KEYS = ["ajorata"];

const LOCALIZED = {
  address: {
    plural: "tieosoitteet",
    singular: "tieosoite"
  },
  coordinate: {
    plural: "koordinaatit",
    singular: "koordinaatti"
  },
  properties: {
    plural: "features",
    singular: "property"
  }
};

const MISSING_VALUE_ERROR = "Kohdetta ei löytynyt";

const CONCURRENT_REQUEST_LIMIT = 5;


//*************** Functions, main


exports.convert = function(buffer) {
  return parseInput(buffer)
    .then(validateValues)
    .then(convertValues)
    .then(buildOutput);
}


//*************** Parse input


function parseInput(buffer) {
  const parse = Promise.method(buffer => {
    const worksheet = xlsx.parse(buffer)[0];
    const table = worksheet.data;
    return { name: worksheet.name, header: headersToKeys(table[0]), values: parseTable(table) };
  });
  return parse(buffer).catch(_ => Promise.reject(Promise.OperationalError("Parsing input failed")));
}


function headersToKeys(headerRow) {
  const headers = R.reject(R.isEmpty, headerRow);
  const allKeys = POINT_KEYS.concat(INTERVAL_KEYS).concat(POINT_DAYS_KEYS);
  const allHeaders = POINT_HEADERS.concat(INTERVAL_HEADERS).concat(POINT_DAYS_HEADERS);
  return R.map(x => allKeys[allHeaders.indexOf(x)], headers);
}


function parseTable(values) {
  const header = values[0] || [];
  const headerConsistsOf = a => R.all(x => R.contains(x, a), header);
  const headerIsValid = headerConsistsOf(POINT_HEADERS) || headerConsistsOf(POINT_DAYS_HEADERS) || headerConsistsOf(INTERVAL_HEADERS);

  if (headerIsValid) {
    const onlyNonEmptyRows = R.reject(R.all(R.isEmpty));
    return tableToObjects(onlyNonEmptyRows(values));
  } else {
    throw Promise.OperationalError("You must specity a header");
  }
}


function tableToObjects(table) {
  const headers = R.head(table);
  const content = R.tail(table);
  return R.map(R.zipObj(headersToKeys(headers)), content);
}


//Tämä funktio jo yllä, tässä selvyyden vuoksi
//function headersToKeys(headerRow) {
//  const headers = R.reject(R.isEmpty, headerRow);
//  const allKeys = POINT_KEYS.concat(INTERVAL_KEYS).concat(POINT_DAYS_KEYS);
//  const allHeaders = POINT_HEADERS.concat(INTERVAL_HEADERS).concat(POINT_DAYS_HEADERS);
//  return R.map(x => allKeys[allHeaders.indexOf(x)], headers);
//}


//*************** Validate values


function validateValues(data) {
  const values = data.values;
  const type = determineType(data.header);
  const valid = x => !R.any(R.isNil, R.flatten(R.map(R.values, x)));
  const requiredValues = type === "intervalRoadAddress" ? R.map(R.omit(OPTIONAL_INTERVAL_KEYS), values) : values;

  if (valid(requiredValues)) {
    return R.merge(data, { type: type });
  } else {
    const validation = x => R.any(R.or(R.isNil, R.isEmpty), R.values(x));
    return Promise.reject(Promise.OperationalError(validationError(validation, requiredValues)));
  }
}


function determineType(headerKeys) {
  const headersEqual = R.equals(headerKeys);
  if (headersEqual(COORDINATE_KEYS)) return "coordinate";
  if (headersEqual(ROAD_ADDRESS_KEYS)) return "roadAddress";
  if (headersEqual(INTERVAL_ROAD_ADDRESS_KEYS)) return "intervalRoadAddress";
  if (headersEqual(ROAD_ADDRESS_KEYS.concat(OTHER_DAYS_KEYS))) return "daysRoadAddress";
  throw Promise.OperationalError("You must specity a header");
}


//*************** Convert values


function convertValues(data) {
  const resultByType = {
    //coordinate: values => addRoadAddresses(values).then(addStreetAddresses),
    coordinate: values => addCoordinates(values),
    //roadAddress: values => addCoordinates(values).then(addStreetAddresses),
    roadAddress: values => addCoordinates(values),
    streetAddress: values => addGeocodedCoordinates(values).then(addRoadAddresses),
    intervalRoadAddress: values => addIntervalCoordinates(values),
    daysRoadAddress: values => addRoadAddressesWDays(values)
  };

  return resultByType[data.type](data.values).then(x => {
    return R.assoc("values", x, data);
  });
}


function addCoordinates(addresses) {
  //return decorateWith(LOCALIZED.address, LOCALIZED.coordinates, addresses, COORDINATE_KEYS);
  return decorateWith(LOCALIZED.address, LOCALIZED.properties, addresses, POINT_KEYS);
}


function addIntervalCoordinates(addresses) {
  //return decorateWith(LOCALIZED.address, LOCALIZED.coordinates, addresses, COORDINATE_KEYS);
  return decorateWith(LOCALIZED.address, LOCALIZED.properties, addresses, INTERVAL_KEYS);
}


function addRoadAddressesWDays(values){

  for (var i in values) {
    var kohdepvm = new Date(1900, 0, values[i].kohdepvm - 1);
    var tilannepvm = new Date(1900, 0, values[i].tilannepvm - 1);
    values[i].kohdepvm = kohdepvm.getDate()+"."+(kohdepvm.getMonth()+1)+"."+kohdepvm.getFullYear();
    values[i].tilannepvm = tilannepvm.getDate()+"."+(tilannepvm.getMonth()+1)+"."+tilannepvm.getFullYear();
  }

  const payload = {};
  payload[LOCALIZED.address.plural] = values;
  const data = {
    //in: LOCALIZED.address.singular,
    //out: LOCALIZED.address.singular,
    //callback: null,
    //tilannepvm: values[0].tilannepvm,
    //kohdepvm: values[0].kohdepvm,
    //alueetpois: null,
    //json: JSON.stringify(payload)
    json: JSONtoValidString(values)
  };
  
  return httpPost(VKM_URL, data).then(function (response) {
    var output = [];
    for (var i in response.features) {
      var tieosoitteet = response.features[i].properties;
      var renamed = renameKeys({ ajorata: 'ajorata_out', etaisyys: 'etaisyys_out', osa: 'osa_out', tie: 'tie_out' })(tieosoitteet);
      var merged = R.merge(renamed, values[i]);
      var obj = [merged];
      output.push(merged);
    }
    return output;
  }).then(R.pipe(
        R.map(R.pick(POINT_DAYS_KEYS.concat(ERROR_KEYS))),
        R.map(validate)));

}


function decorateWith(inputType, outputType, values, whitelistedKeys) {
  const payload = {};
  payload[inputType.plural] = values;
  const data = {
    //in: inputType.singular,
    //out: outputType.singular,
    //callback: null,
    //kohdepvm: null,
    //json: JSON.stringify(payload)
    //json: JSON.stringify(values)
    json: JSONtoValidString(values)
  };
  outputType = LOCALIZED.properties;
  return httpPost(VKM_URL, data).then(R.pipe(
        R.propOr(values, outputType.plural),
        R.map(R.prop("properties")),
        R.map(R.pick(whitelistedKeys.concat(ERROR_KEYS))),
        mergeAllWith(values),
        R.map(validate)));
}


function JSONtoValidString(values) {
console.log('JSONtoValidString');
  var str = JSON.stringify(values);
  str = str.replaceAll('"ajorata":0','"ajorata":"0"');
  str = str.replaceAll('"ajorata":1','"ajorata":"1"');
  str = str.replaceAll('"ajorata":2','"ajorata":"2"');
  return str;
}

function httpPost(url, params) {
  return rp.post({
    url: url,
    form: params,
    encoding: "utf-8",
    headers: { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8" }
  }).then(parseJSON);
}


function mergeAllWith(xs) {
  console.log(R);
  const defaults = R.flip(R.merge);
  return R.zipWith(defaults, xs);
}


function parseJSON(str) {
  console.log(str);
  var str2 = str.trim() ? JSON.parse(str) : {};
  console.log(str2);
  return str.trim() ? JSON.parse(str) : {};
}


function validate(x) {
  console.log(x);
  if (R.has("valid", x)) return x;
  //const validationStatus = x.palautusarvo === 1 ?
  const validationStatus = x.virheet == null ?
    { valid: true } :
    //{ valid: false, error: x.virheteksti || MISSING_VALUE_ERROR };
    { valid: false, error: x.virheet || MISSING_VALUE_ERROR };
  return R.merge(R.omit(EXTERNAL_ERROR_KEYS, x), validationStatus);
}


//*************** Build output


function buildOutput(data) {
  const interval = data.type === "intervalRoadAddress";
  const bydays = data.type === "daysRoadAddress";
  var keys;
  var headers;

  if(interval){
    keys = INTERVAL_KEYS;
    headers = INTERVAL_HEADERS;
  }else if(bydays){
    keys = POINT_DAYS_KEYS;
    headers = POINT_DAYS_HEADERS;
  }else{
    keys = POINT_KEYS;
    headers = POINT_HEADERS;
  }

  const values = data.values;
  const valuesOrderedByKeys = values.map(x => {
    const valueOrderedByKeys = keys.map(key => R.prop(key, x));
    return x.valid ? valueOrderedByKeys : valueOrderedByKeys.concat(x.error);
  });

  const metadata = getMetadata(values);
  const headerRow = metadata.errors ? headers.concat(ERROR_HEADER) : headers;
  const table = [headerRow].concat(valuesOrderedByKeys);

  return {
    xlsx: xlsx.build([{name: data.fileName, data: table }]),
    metadata: metadata
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


//*************** Needed


function validationError(validationFn, data) {
  const rowOffset = 2;
  return {
    errors: true,
    errorCount: R.filter(validationFn, data).length,
    firstError: R.findIndex(validationFn, data) + rowOffset
  };
}


/**
 * Creates a new object with the own properties of the provided object, but the
 * keys renamed according to the keysMap object as `{oldKey: newKey}`.
 * When some key is not found in the keysMap, then it's passed as-is.
 *
 * Keep in mind that in the case of keys conflict is behaviour undefined and
 * the result may vary between various JS engines!
 *
 * @sig {a: b} -> {a: *} -> {b: *}
 */
const renameKeys = R.curry((keysMap, obj) => {
  return R.reduce((acc, key) => {
    acc[keysMap[key] || key] = obj[key];
    return acc;
  }, {}, R.keys(obj));
});