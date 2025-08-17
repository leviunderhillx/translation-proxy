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
const loadStart = Date.now();
const estimatedLoadTime = 300000; // 5 minutes for larger NLLB; adjust based on testing

(async () => {
    try {
        // Switch to NLLB for fast tokenizer support (multilingual)
        translator = await pipeline('translation', 'Xenova/nllb-200-distilled-600M', { cache_dir: cacheDir });
        console.log('Model loaded successfully');
    } catch (error) {
        console.error('Error loading model:', error);
    }
})();

app.use(express.urlencoded({ extended: true })); // For POST forms
app.use(express.json());

// Status endpoint for polling
app.get('/status', (req, res) => {
    const ready = !!translator;
    const elapsed = Date.now() - loadStart;
    const remaining = Math.max(0, estimatedLoadTime - elapsed) / 1000; // in seconds
    res.json({ ready, remaining: Math.round(remaining) });
});

// Ping endpoint to keep server awake
app.get('/ping', (req, res) => {
    res.send('OK');
});

// Serve frontend with improved styling, polling, and keep-awake button
app.get('/', (req, res) => {
    res.send(`
        <!DOCTYPE html>
        <html lang="en">
        <head>
            <title>Translation Proxy</title>
            <style>
                body {
                    font-family: Arial, sans-serif;
                    display: flex;
                    justify-content: center;
                    align-items: center;
                    height: 100vh;
                    margin: 0;
                    background-color: #f0f0f0;
                    position: relative;
                }
                #container {
                    text-align: center;
                    background: white;
                    padding: 20px;
                    border-radius: 8px;
                    box-shadow: 0 4px 8px rgba(0, 0, 0, 0.1);
                    width: 80%;
                    max-width: 600px;
                }
                #urlInput {
                    width: 70%;
                    padding: 10px;
                    margin-right: 10px;
                }
                #langSelect {
                    padding: 10px;
                    margin-right: 10px;
                }
                button {
                    padding: 10px 20px;
                }
                #proxyFrame {
                    width: 100%;
                    height: 80vh;
                    border: none;
                    margin-top: 20px;
                }
                #status {
                    position: absolute;
                    top: 10px;
                    left: 10px;
                    background: #fff;
                    padding: 10px;
                    border-radius: 5px;
                    box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
                    font-size: 14px;
                    color: #333;
                }
                #keepAwake {
                    position: absolute;
                    top: 10px;
                    right: 10px;
                    padding: 8px 16px;
                    background: #007bff;
                    color: white;
                    border: none;
                    border-radius: 5px;
                    cursor: pointer;
                    font-size: 14px;
                }
                #keepAwake:hover {
                    background: #0056b3;
                }
            </style>
        </head>
        <body>
            <div id="status">Checking model status...</div>
            <button id="keepAwake" onclick="keepAwake()">Keep Awake</button>
            <div id="container">
                <input id="urlInput" placeholder="Enter purchase link (e.g., https://amazon.com)">
                <select id="langSelect">
                    <option value="fra_Latn">French</option> <!-- NLLB uses codes like fra_Latn; add more e.g., <option value="deu_Latn">German</option> -->
                </select>
                <button onclick="loadPage()">Load</button>
                <iframe id="proxyFrame"></iframe>
            </div>
            <script>
                function loadPage() {
                    const url = document.getElementById('urlInput').value;
                    const lang = document.getElementById('langSelect').value;
                    if (url) {
                        document.getElementById('proxyFrame').src = '/proxy?url=' + encodeURIComponent(url) + '&lang=' + lang;
                    }
                }

                function keepAwake() {
                    fetch('/ping').catch(() => {}); // Does nothing visible, but pings server
                }

                // Polling for model status
                function updateStatus() {
                    fetch('/status')
                        .then(response => response.json())
                        .then(data => {
                            const statusDiv = document.getElementById('status');
                            if (data.ready) {
                                statusDiv.textContent = 'Model ready!';
                            } else {
                                statusDiv.textContent = 'Loading model... (~' + data.remaining + ' seconds left)';
                            }
                        })
                        .catch(error => {
                            document.getElementById('status').textContent = 'Status check failed';
                        });
                }
                setInterval(updateStatus, 5000); // Poll every 5 seconds
                updateStatus(); // Initial check
            </script>
        </body>
        </html>
    `);
});

// Proxy route
app.all('/proxy', async (req, res) => {
    const originalUrl = req.query.url;
    const targetLang = req.query.lang || 'fra_Latn'; // NLLB code for French
    if (!originalUrl) return res.status(400).send('No URL provided');

    if (!translator) return res.status(503).send('Translator model not loaded yet');

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

        let sourceLang = pageLang; // Map to NLLB codes if needed (e.g., 'en' -> 'eng_Latn')
        if (sourceLang === 'en') sourceLang = 'eng_Latn';
        // Add more mappings as needed for accuracy

        if (pageLang !== targetLang.split('_')[0]) { // Rough check
            // Traverse and translate text nodes
            const textNodes = [];
            $('body').find('*').contents().each(function () {
                if (this.type === 'text' && this.data.trim()) {
                    textNodes.push(this);
                }
            });

            for (const node of textNodes) {
                const translated = await translator(node.data, { src_lang: sourceLang, tgt_lang: targetLang });
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