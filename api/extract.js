const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const archiver = require('archiver');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const path = require('path');
const cors = require('cors');

const app = express();

// Middleware
app.use(express.json({ limit: '50mb' }));
app.use(cors({
    origin: '*',
    methods: ['POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type']
}));

// Constants
const MAX_CONCURRENT_DOWNLOADS = 10;
const CHUNK_SIZE = 15;
const MAX_SIZE_MB = 500; // Maximum size in MB
const TEMP_DIR = path.join(__dirname, 'temp');

// Ensure temp directory exists
if (!fs.existsSync(TEMP_DIR)) {
    fs.mkdirSync(TEMP_DIR);
}

// Health check endpoint
app.get('/health', (req, res) => {
    res.status(200).send('OK');
});

// Main extraction endpoint
app.post('/api/extract', async (req, res) => {
    let tempDir = null;
    
    try {
        const targetUrl = req.body.url;
        if (!isValidWebflowUrl(targetUrl)) {
            return res.status(400).json({
                error: 'Invalid URL',
                message: 'Please provide a valid Webflow URL'
            });
        }

        console.log('Starting extraction:', targetUrl);

        tempDir = path.join(TEMP_DIR, `temp-${uuidv4()}`);
        fs.mkdirSync(tempDir, { recursive: true });

        const baseUrl = new URL(targetUrl).origin;
        const baseHost = new URL(targetUrl).host;
        const visitedUrls = new Set();
        const visitedAssets = new Set();
        const urlQueue = [targetUrl];

        let totalSize = 0;

        while (urlQueue.length > 0) {
            const chunk = urlQueue.splice(0, CHUNK_SIZE);
            await Promise.all(
                chunk.map(async (currentUrl) => {
                    if (!visitedUrls.has(currentUrl)) {
                        visitedUrls.add(currentUrl);
                        const pageSize = await downloadPage(currentUrl, baseUrl, baseHost, tempDir, visitedUrls, visitedAssets, urlQueue);
                        totalSize += pageSize;

                        if (totalSize > MAX_SIZE_MB * 1024 * 1024) {
                            throw new Error(`Site is too large (exceeds ${MAX_SIZE_MB}MB)`);
                        }
                    }
                })
            );
        }

        console.log('Creating ZIP archive...');

        // Set headers for chunked transfer
        res.setHeader('Transfer-Encoding', 'chunked');
        res.setHeader('Content-Type', 'application/zip');
        res.setHeader('Content-Disposition', 'attachment; filename=webflow-site.zip');

        const archive = archiver('zip', {
            zlib: { level: 9 },
            store: true
        });

        archive.on('warning', function(err) {
            console.warn('Archive warning:', err);
        });

        archive.on('error', function(err) {
            throw err;
        });

        // Monitor archive progress
        archive.on('progress', (progress) => {
            console.log('Archive progress:', Math.round(progress.entries.processed / progress.entries.total * 100) + '%');
        });

        archive.pipe(res);
        archive.directory(tempDir, false);
        await archive.finalize();

        console.log('Extraction complete');

    } catch (error) {
        console.error('Extraction error:', error);
        if (!res.headersSent) {
            res.status(500).json({
                error: 'Extraction failed',
                message: error.message
            });
        }
    } finally {
        if (tempDir && fs.existsSync(tempDir)) {
            try {
                fs.rmSync(tempDir, { recursive: true, force: true });
            } catch (error) {
                console.error('Cleanup error:', error);
            }
        }
    }
});

async function downloadPage(url, baseUrl, baseHost, tempDir, visitedUrls, visitedAssets, urlQueue) {
    try {
        console.log('Downloading page:', url);
        
        const { data: html } = await axios.get(url, {
            timeout: 30000,
            maxContentLength: 50 * 1024 * 1024,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
            }
        });

        let pageSize = Buffer.byteLength(html);

        const $ = cheerio.load(html);
        const localFilePath = getLocalFilePath(url, baseUrl, tempDir);
        const pageDir = path.dirname(localFilePath);

        const assets = [];
        $('link[href], script[src], img[src], source[src]').each((i, el) => {
            const attr = el.attribs.href ? 'href' : 'src';
            let assetUrl = el.attribs[attr];
            if (!assetUrl) return;

            if (assetUrl.startsWith('http') || assetUrl.startsWith('//')) {
                assetUrl = assetUrl.startsWith('//') ? 'https:' + assetUrl : assetUrl;
            } else {
                try {
                    assetUrl = new URL(assetUrl, url).href;
                } catch (e) {
                    return;
                }
            }

            if (assetUrl.includes('data:')) return;
            assets.push({ url: assetUrl, element: el, attr });
        });

        for (let i = 0; i < assets.length; i += MAX_CONCURRENT_DOWNLOADS) {
            const chunk = assets.slice(i, i + MAX_CONCURRENT_DOWNLOADS);
            const assetSizes = await Promise.all(
                chunk.map(async ({ url: assetUrl, element, attr }) => {
                    if (!visitedAssets.has(assetUrl)) {
                        visitedAssets.add(assetUrl);
                        try {
                            const assetUrlObj = new URL(assetUrl);
                            const assetPath = assetUrlObj.host === baseHost
                                ? path.join(tempDir, assetUrlObj.pathname)
                                : path.join(tempDir, 'assets', assetUrlObj.host, assetUrlObj.pathname);

                            const assetSize = await downloadAsset(assetUrl, assetPath);
                            const relativeAssetPath = path.relative(pageDir, assetPath).replace(/\\/g, '/');
                            element.attribs[attr] = encodeURI(relativeAssetPath);
                            return assetSize;
                        } catch (error) {
                            console.error(`Failed to download asset: ${assetUrl}`, error);
                            return 0;
                        }
                    }
                    return 0;
                })
            );
            
            pageSize += assetSizes.reduce((a, b) => a + b, 0);
        }

        $('a[href]').each((i, el) => {
            const href = el.attribs.href;
            if (!href || href.startsWith('mailto:') || href.startsWith('tel:') || href.startsWith('#')) {
                return;
            }

            try {
                const absoluteLink = new URL(href, url).href;
                const normalizedLink = absoluteLink.split('#')[0].split('?')[0];

                if (normalizedLink.startsWith(baseUrl)) {
                    if (!visitedUrls.has(normalizedLink) && !urlQueue.includes(normalizedLink)) {
                        urlQueue.push(normalizedLink);
                    }

                    const localLinkPath = getLocalFilePath(normalizedLink, baseUrl, tempDir);
                    let relativeLinkPath = path.relative(pageDir, localLinkPath).replace(/\\/g, '/');
                    el.attribs.href = encodeURI(relativeLinkPath);
                }
            } catch (error) {
                // Skip invalid URLs
            }
        });

        fs.mkdirSync(pageDir, { recursive: true });
        fs.writeFileSync(localFilePath, $.html(), 'utf-8');

        return pageSize;
    } catch (error) {
        console.error(`Failed to download page ${url}:`, error);
        return 0;
    }
}

async function downloadAsset(url, filePath, retries = 3) {
    for (let i = 0; i < retries; i++) {
        try {
            const response = await axios.get(url, {
                responseType: 'arraybuffer',
                timeout: 10000,
                maxContentLength: 50 * 1024 * 1024,
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
                }
            });

            const assetSize = response.data.length;
            if (assetSize > MAX_SIZE_MB * 1024 * 1024) {
                throw new Error(`Asset size exceeds ${MAX_SIZE_MB}MB limit`);
            }

            fs.mkdirSync(path.dirname(filePath), { recursive: true });
            fs.writeFileSync(filePath, response.data);
            return assetSize;
        } catch (error) {
            if (i === retries - 1) throw error;
            await new Promise(resolve => setTimeout(resolve, 1000 * Math.pow(2, i)));
        }
    }
    return 0;
}

function getLocalFilePath(url, baseUrl, tempDir) {
    const urlObj = new URL(url);
    let localPath = path.join(tempDir, decodeURIComponent(urlObj.pathname));

    if (urlObj.pathname.endsWith('/')) {
        localPath = path.join(tempDir, urlObj.pathname, 'index.html');
    } else {
        const extname = path.extname(urlObj.pathname);
        if (!extname || !['.html', '.htm'].includes(extname.toLowerCase())) {
            localPath += '.html';
        }
    }
    return localPath;
}

function isValidWebflowUrl(url) {
    try {
        const parsedUrl = new URL(url);
        return (
            parsedUrl.hostname.endsWith('webflow.io') ||
            parsedUrl.hostname.endsWith('webflow.com')
        );
    } catch {
        return false;
    }
}

// Cleanup old temp files periodically
setInterval(() => {
    try {
        const files = fs.readdirSync(TEMP_DIR);
        const now = Date.now();
        files.forEach(file => {
            const filePath = path.join(TEMP_DIR, file);
            const stats = fs.statSync(filePath);
            if (now - stats.mtime.getTime() > 3600000) { // 1 hour
                fs.rmSync(filePath, { recursive: true, force: true });
            }
        });
    } catch (error) {
        console.error('Cleanup error:', error);
    }
}, 3600000); // Run every hour

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
    console.log(`Temp directory: ${TEMP_DIR}`);
});

module.exports = app;
