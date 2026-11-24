// The Swagger UI page served at "/". It loads the UI from jsDelivr (pinned,
// with subresource integrity) and the spec from /openapi.json, so the Worker
// bundle carries neither the UI assets nor a prebuilt spec.
export const SWAGGER_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="utf-8"/>
    <meta name="viewport" content="width=device-width, initial-scale=1"/>
    <meta name="description" content="SwaggerUI"/>
    <title>SwaggerUI</title>
    <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/swagger-ui-dist@5.17.14/swagger-ui.css" integrity="sha256-QBcPDuhZ0X+SExunBzKaiKBw5PZodNETZemnfSMvYRc=" crossorigin="anonymous">
</head>
<body>
<div id="swagger-ui"></div>
<script src="https://cdn.jsdelivr.net/npm/swagger-ui-dist@5.17.14/swagger-ui-bundle.js" integrity="sha256-wuSp7wgUSDn/R8FCAgY+z+TlnnCk5xVKJr1Q2IDIi6E=" crossorigin="anonymous"></script>
<script src="https://cdn.jsdelivr.net/npm/swagger-ui-dist@5.17.14/swagger-ui-standalone-preset.js" integrity="sha256-M7em9a/KxJAv35MoG+LS4S2xXyQdOEYG5ubRd0W3+G8=" crossorigin="anonymous"></script>
<script>
    window.onload = () => {
        window.ui = SwaggerUIBundle({
            url: '/openapi.json',
            dom_id: '#swagger-ui',
            deepLinking: true,
            presets: [
                SwaggerUIBundle.presets.apis
            ]
        });
    };
</script>
</body>
</html>`;
