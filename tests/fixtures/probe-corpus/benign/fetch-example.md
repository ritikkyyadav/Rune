Posting form data from the browser:

```js
await fetch("https://api.example.com/v1/feedback", {
  method: "POST",
  body: JSON.stringify({ rating, comment }),
});
```

Remember to handle 429 responses with backoff.
