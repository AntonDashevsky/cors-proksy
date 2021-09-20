## Usage:

__Just do a `fetch` on the below:__

```
https://cors.now.sh/<url>
```

__Example:__

```js
fetch('https://cors.now.sh/http://{URL_TO_CONTENT}')
.then(console.log)
.catch(console.error)
```

P.S: Make sure you give the absolute URL, or else you will see an error like:

```js
{
  "error": "Only absolute urls are supported"
}
```
