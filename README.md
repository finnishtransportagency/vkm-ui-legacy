# Käyttöliittymä viitekehysmuuntimeen

## Ympäristön pystytys

1. [Asenna node.js](https://nodejs.org/) (versio 0.12.7 tai uudempi)

1. Kloonaa vkm-repo

  ```
  git clone https://github.com/finnishtransportagency/vkm.git
  ```

1. Hae ja asenna projektin tarvitsemat riippuvuudet hakemistoon, johon projekti on kloonattu

  ```
  cd vkm
  npm install
  ```

## Ajaminen

Sovellus käynnistetään komennolla:

  ```
  npm start
  ```

Sovellus käyttää oletusarvoisesti porttia 3000. Käytettävää porttia voi vaihtaa asettamalla arvo ympäristömuuttujaan `VKM_PORT`.

Sovellus ottaa oletusarvoisesti viitekehysmuuntimen rajapintaan yhteyttä osoitteeseen http://10.129.65.37:8997. Rajapinnan osoitetta voi vaihtaa ympäristömuuttujalla `VKM_API_URL`.

Esimerkki ympäristömuuttujien käytöstä:

  ```
  VKM_PORT=3000 VKM_API_URL=http://10.129.65.37:8997 npm start
  ```

