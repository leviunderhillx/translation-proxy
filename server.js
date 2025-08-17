const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const { pipeline } = require('@xenova/transformers');
const URL = require('url-parse');
const fs = require('fs');
const path = require('path');

const app = express();
const port = process.env.PORT || 3000;
const cacheDir = process.env.CACHE_DIR || './.cache'; // Use env var for potential future persistence

// Ensure cache dir exists
if (!fs.existsSync(cacheDir)) {
    fs.mkdirSync(cacheDir, { recursive: true });
}

let translator;
(async () => {
    try {
        // Use smaller model for free tier compatibility (English to French example)
        translator = await pipeline('translation', 'Xenova/opus-mt-en-fr', { cache_dir: cacheDir });
        console.log('Model loaded successfully');
    } catch (error) {
        console.error('Error loading model:', error);
    }
})();

app.use(express.urlencoded({ extended: true })); // For POST forms
app.use(express.json());

// Serve frontend (updated select to match model: only French for now)
app.get('/', (req, res) => {
    res.send(`
        <!DOCTYPE html>
        <html lang="en">
        <head><title>Translation Proxy</title></head>
        <body>
            <input id="urlInput" placeholder="Enter purchase link" style="width: 80%;">
            <select id="langSelect">
                <option value="fr">French</option>
                <!-- Add more if using multiple models -->
            </select>
            <button onclick="loadPage()">Load</button>
            <iframe id="proxyFrame" style="width:100%; height:80vh; border:none;"></iframe>
            <script>
                function loadPage() {
                    const url = document.getElementById('urlInput').value;
                    const lang = document.getElementById('langSelect').value;
                    if (url) {
                        document.getElementById('proxyFrame').src = '/proxy?url=' + encodeURIComponent(url) + '&lang=' + lang;
                    }
                }
            </script>
        </body>
        </html>
    `);
});

// Proxy route
app.all('/proxy', async (req, res) => {
    const originalUrl = req.query.url;
    const targetLang = req.query.lang || 'fr'; // Default to French
    if (!originalUrl) return res.status(400).send('No URL provided');

    if (!translator) return res.status(500).send('Translator model not loaded yet');

    try {
        // Fetch original page (handle GET/POST)
        const method = req.method.toLowerCase();
        const response = await axios({
            method,
            url: originalUrl,
            data: req.body,
            headers: { 'User-Agent': 'Mozilla/5.0' }, // Mimic browser
            responseType: 'text',
        });

        if (!response.headers['content-type'].includes('text/html')) {
            // Non-HTML: Proxy directly (e.g., images, JS)
            return res.send(response.data);
        }

        // Parse HTML
        const $ = cheerio.load(response.data);
        const pageLang = $('html').attr('lang') || 'und';

        if (pageLang !== targetLang) {
            // Traverse and translate text nodes
            const textNodes = [];
            $('body').find('*').contents().each(function () {
                if (this.type === 'text' && this.data.trim()) {
                    textNodes.push(this);
                }
            });

            for (const node of textNodes) {
                // For OPUS-MT, no src/tgt codes needed; it assumes en-to-fr
                const translated = await translator(node.data);
                node.data = translated[0].translation_text;
            }
        }

        // Rewrite URLs for proxying (links, forms, scripts, etc.)
        const baseUrl = new URL(originalUrl);
        $('a[href], link[href], script[src], img[src], form[action]').each(function () {
            const attr = $(this).attr('href') ? 'href' : $(this).attr('src') ? 'src' : 'action';
            let link = $(this).attr(attr);
            if (link && !link.startsWith('http')) {
                link = baseUrl.origin + (link.startsWith('/') ? link : '/' + link);
            }
            if (link.startsWith('http')) {
                $(this).attr(attr, `/proxy?url=${encodeURIComponent(link)}&lang=${targetLang}`);
            }
        });

        // Handle forms method
        $('form').attr('method', 'POST'); // Ensure proxy handles POST

        res.send($.html());
    } catch (error) {
        res.status(500).send('Error proxying: ' + error.message);
    }
});

app.listen(port, () => console.log(`Server on port ${port}`));