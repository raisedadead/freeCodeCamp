---
id: bd7158d8c443edefaeb5bdff
title: Microservizio Parser di header della richiesta
challengeType: 4
forumTopicId: 301507
dashedName: request-header-parser-microservice
---

# --description--

Costruisci un'app JavaScript full-stack che sia funzionalmente simile a questa: <a href="https://request-header-parser-microservice.freecodecamp.rocks/" target="_blank" rel="noopener noreferrer nofollow">https://request-header-parser-microservice.freecodecamp.rocks/</a>. Lavorare su questo progetto ti porterà a scrivere il tuo codice utilizzando uno dei seguenti metodi:

-   Clonare <a href="https://github.com/freeCodeCamp/boilerplate-project-headerparser/" target="_blank" rel="noopener noreferrer nofollow">questa repository GitHub</a> e completare il tuo progetto localmente.
-   Use <a href="https://gitpod.io/?autostart=true#https://github.com/freeCodeCamp/boilerplate-project-headerparser/" target="_blank" rel="noopener noreferrer nofollow">our Gitpod starter project</a> to complete your project.
-   Usare un costruttore di siti di tua scelta per completare il progetto. Assicurati di incorporare tutti i file del nostro repository GitHub.

# --hints--

È necessario fornire il proprio progetto, non l'URL di esempio.

```js
(getUserInput) => {
  assert(
    !/.*\/request-header-parser-microservice\.freecodecamp\.rocks/.test(
      getUserInput('url')
    )
  );
};
```

Una richiesta a `/api/whoami` dovrebbe restituire un oggetto JSON con il tuo indirizzo IP nella chiave `ipaddress`.

```js
(getUserInput) =>
  $.get(getUserInput('url') + '/api/whoami').then(
    (data) => assert(data.ipaddress && data.ipaddress.length > 0),
    (xhr) => {
      throw new Error(xhr.responseText);
    }
  );
```

Una richiesta a `/api/whoami` dovrebbe restituire un oggetto JSON con la tua lingua preferita nella chiave `language`.

```js
(getUserInput) =>
  $.get(getUserInput('url') + '/api/whoami').then(
    (data) => assert(data.language && data.language.length > 0),
    (xhr) => {
      throw new Error(xhr.responseText);
    }
  );
```

Una richiesta a `/api/whoami` dovrebbe restituire un oggetto JSON con il tuo software nella chiave `software`.

```js
(getUserInput) =>
  $.get(getUserInput('url') + '/api/whoami').then(
    (data) => assert(data.software && data.software.length > 0),
    (xhr) => {
      throw new Error(xhr.responseText);
    }
  );
```

