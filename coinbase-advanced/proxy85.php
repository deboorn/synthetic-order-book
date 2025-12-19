<?php
/**
 * Coinbase Advanced Trade API Proxy (Windows IIS / PHP 8.5 Compatible)
 * 
 * This version includes SSL certificate handling for Windows environments
 * where the CA bundle may not be automatically found.
 * 
 * SETUP FOR WINDOWS:
 * 1. Download cacert.pem from https://curl.se/ca/cacert.pem
 * 2. Save it to C:\php\extras\ssl\cacert.pem (or your preferred location)
 * 3. Update the CACERT_PATH constant below OR add to php.ini:
 *    curl.cainfo = "C:\php\extras\ssl\cacert.pem"
 *    openssl.cafile = "C:\php\extras\ssl\cacert.pem"
 * 
 * @copyright 2025 Daniel Boorn <daniel.boorn@gmail.com>
 * @license Personal use only. Not for commercial reproduction.
 */

// ============================================================================
// CONFIGURATION - Adjust these for your Windows environment
// ============================================================================

// Path to CA certificate bundle (download from https://curl.se/ca/cacert.pem)
// Set to null to use php.ini settings, or specify full path
define('CACERT_PATH', null); // e.g., 'C:\\php\\extras\\ssl\\cacert.pem'

// Set to true to disable SSL verification (NOT RECOMMENDED for production!)
// Only use this for testing if you can't get the CA bundle working
define('DISABLE_SSL_VERIFY', false);

// ============================================================================
// END CONFIGURATION
// ============================================================================

// Enable all errors for debugging
error_reporting(E_ALL);
ini_set('display_errors', 0);

// Set headers
header('Content-Type: application/json');
header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Methods: POST, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type');

// Custom error handler
set_error_handler(function($errno, $errstr, $errfile, $errline) {
    throw new ErrorException($errstr, 0, $errno, $errfile, $errline);
});

// Handle preflight OPTIONS request
if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
    http_response_code(200);
    exit;
}

// Only allow POST requests
if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    http_response_code(405);
    echo json_encode(['error' => 'Method not allowed']);
    exit;
}

/**
 * Return error as JSON response
 */
function returnError($message, $details = [], $code = 500) {
    http_response_code($code);
    echo json_encode(array_merge([
        'error' => $message,
        'php_version' => PHP_VERSION,
        'openssl_version' => OPENSSL_VERSION_TEXT,
        'os' => PHP_OS,
        'cacert_path' => CACERT_PATH,
        'ssl_verify_disabled' => DISABLE_SSL_VERIFY
    ], $details));
    exit;
}

/**
 * Base64 URL encode (JWT-safe)
 */
function base64UrlEncode($data) {
    return rtrim(strtr(base64_encode($data), '+/', '-_'), '=');
}

/**
 * Normalize and fix PEM key format
 */
function normalizePemKey($key) {
    $key = trim($key);
    
    // Convert escaped newlines to real newlines
    $key = str_replace('\\n', "\n", $key);
    
    // Replace Windows line endings
    $key = str_replace("\r\n", "\n", $key);
    $key = str_replace("\r", "\n", $key);
    
    // Check if it's an EC PRIVATE KEY
    if (strpos($key, '-----BEGIN EC PRIVATE KEY-----') !== false) {
        $pattern = '/-----BEGIN EC PRIVATE KEY-----(.+?)-----END EC PRIVATE KEY-----/s';
        if (preg_match($pattern, $key, $matches)) {
            $base64 = preg_replace('/\s+/', '', $matches[1]);
            $formatted = "-----BEGIN EC PRIVATE KEY-----\n";
            $formatted .= chunk_split($base64, 64, "\n");
            $formatted .= "-----END EC PRIVATE KEY-----";
            return trim($formatted);
        }
    }
    
    return $key;
}

/**
 * Convert DER-encoded ECDSA signature to raw R||S format (64 bytes for ES256)
 */
function signatureFromDER($der) {
    $pos = 0;
    $size = strlen($der);
    
    // Check SEQUENCE tag (0x30)
    if (ord($der[$pos++]) !== 0x30) {
        throw new Exception('Invalid DER: expected SEQUENCE');
    }
    
    // Read SEQUENCE length
    $len = ord($der[$pos++]);
    if ($len & 0x80) {
        $lenBytes = $len & 0x7F;
        $len = 0;
        for ($i = 0; $i < $lenBytes; $i++) {
            $len = ($len << 8) | ord($der[$pos++]);
        }
    }
    
    // Read R INTEGER
    if (ord($der[$pos++]) !== 0x02) {
        throw new Exception('Invalid DER: expected INTEGER for R');
    }
    $rLen = ord($der[$pos++]);
    $r = substr($der, $pos, $rLen);
    $pos += $rLen;
    
    // Read S INTEGER
    if (ord($der[$pos++]) !== 0x02) {
        throw new Exception('Invalid DER: expected INTEGER for S');
    }
    $sLen = ord($der[$pos++]);
    $s = substr($der, $pos, $sLen);
    
    // ES256 uses 32-byte R and S values
    $r = ltrim($r, "\x00");
    $s = ltrim($s, "\x00");
    
    // Pad to exactly 32 bytes
    $r = str_pad($r, 32, "\x00", STR_PAD_LEFT);
    $s = str_pad($s, 32, "\x00", STR_PAD_LEFT);
    
    return $r . $s;
}

/**
 * Generate JWT for Coinbase API
 */
function generateJWT($keyName, $keySecret, $requestMethod = '', $requestPath = '') {
    $time = time();
    $nonce = bin2hex(random_bytes(16));
    
    // JWT Payload (claims)
    $payload = [
        'sub' => $keyName,
        'iss' => 'cdp',
        'nbf' => $time,
        'exp' => $time + 120
    ];
    
    // Add URI claim only for REST API calls (not WebSocket)
    if (!empty($requestMethod) && !empty($requestPath)) {
        $url = 'api.coinbase.com';
        $uri = $requestMethod . ' ' . $url . $requestPath;
        $payload['uri'] = $uri;
    }
    
    // JWT Header
    $header = [
        'typ' => 'JWT',
        'alg' => 'ES256',
        'kid' => $keyName,
        'nonce' => $nonce
    ];
    
    // Normalize the private key
    $normalizedKey = normalizePemKey($keySecret);
    
    // Parse the private key
    $privateKey = @openssl_pkey_get_private($normalizedKey);
    if (!$privateKey) {
        throw new Exception('Failed to parse private key: ' . openssl_error_string());
    }
    
    // Encode header and payload
    $headerEncoded = base64UrlEncode(json_encode($header));
    $payloadEncoded = base64UrlEncode(json_encode($payload));
    $dataToSign = $headerEncoded . '.' . $payloadEncoded;
    
    // Sign with ES256 (ECDSA with SHA-256)
    $signature = '';
    $success = openssl_sign($dataToSign, $signature, $privateKey, OPENSSL_ALGO_SHA256);
    
    if (!$success) {
        throw new Exception('Failed to sign JWT: ' . openssl_error_string());
    }
    
    // Convert DER signature to raw R||S format for JWT
    $rawSignature = signatureFromDER($signature);
    $signatureEncoded = base64UrlEncode($rawSignature);
    
    return $headerEncoded . '.' . $payloadEncoded . '.' . $signatureEncoded;
}

/**
 * Configure cURL SSL options for Windows
 */
function configureCurlSSL($ch) {
    if (DISABLE_SSL_VERIFY) {
        // WARNING: This disables SSL verification - only use for testing!
        curl_setopt($ch, CURLOPT_SSL_VERIFYPEER, false);
        curl_setopt($ch, CURLOPT_SSL_VERIFYHOST, 0);
        return;
    }
    
    // Enable SSL verification
    curl_setopt($ch, CURLOPT_SSL_VERIFYPEER, true);
    curl_setopt($ch, CURLOPT_SSL_VERIFYHOST, 2);
    
    // Set CA certificate path if configured
    if (CACERT_PATH && file_exists(CACERT_PATH)) {
        curl_setopt($ch, CURLOPT_CAINFO, CACERT_PATH);
    } else {
        // Try common Windows locations
        $commonPaths = [
            'C:\\php\\extras\\ssl\\cacert.pem',
            'C:\\php\\cacert.pem',
            'C:\\cacert.pem',
            dirname(__FILE__) . '\\cacert.pem', // Same directory as this script
            dirname(__FILE__) . '/cacert.pem',
        ];
        
        foreach ($commonPaths as $path) {
            if (file_exists($path)) {
                curl_setopt($ch, CURLOPT_CAINFO, $path);
                break;
            }
        }
    }
}

// Wrap everything in try-catch
try {
    // Get request parameters
    $action = $_POST['action'] ?? 'proxy';
    $endpoint = $_POST['endpoint'] ?? '';
    $method = strtoupper($_POST['method'] ?? 'GET');
    $body = $_POST['body'] ?? '';
    $apiKey = $_POST['apiKey'] ?? '';
    $privateKey = $_POST['privateKey'] ?? '';
    
    // Validate credentials
    if (empty($apiKey) || empty($privateKey)) {
        returnError('Missing API credentials', [
            'hasApiKey' => !empty($apiKey),
            'hasPrivateKey' => !empty($privateKey)
        ], 400);
    }
    
    // Action: jwt - Return just a JWT token for WebSocket use
    if ($action === 'jwt') {
        $jwt = generateJWT($apiKey, $privateKey);
        echo json_encode([
            'success' => true,
            'jwt' => $jwt,
            'expires_in' => 120
        ]);
        exit;
    }
    
    // Action: proxy (default)
    if (empty($endpoint)) {
        returnError('Missing endpoint parameter', [], 400);
    }
    
    // Strip query params for JWT URI
    $pathForJwt = explode('?', $endpoint)[0];
    
    // Generate JWT
    $jwt = generateJWT($apiKey, $privateKey, $method, $pathForJwt);
    
    // Coinbase production API
    $baseUrl = 'https://api.coinbase.com';
    $url = $baseUrl . $endpoint;
    
    // Initialize cURL
    $ch = curl_init();
    
    // Configure SSL for Windows
    configureCurlSSL($ch);
    
    // Build headers
    $headers = [
        'Content-Type: application/json',
        'Accept: application/json',
        'Authorization: Bearer ' . $jwt,
    ];
    
    // Set cURL options
    curl_setopt_array($ch, [
        CURLOPT_URL => $url,
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_TIMEOUT => 30,
        CURLOPT_FOLLOWLOCATION => true,
        CURLOPT_HTTP_VERSION => CURL_HTTP_VERSION_1_1,
        CURLOPT_CUSTOMREQUEST => $method,
        CURLOPT_HTTPHEADER => $headers,
    ]);
    
    // Add body for POST/PUT/PATCH requests
    if (in_array($method, ['POST', 'PUT', 'PATCH']) && !empty($body)) {
        curl_setopt($ch, CURLOPT_POSTFIELDS, $body);
    }
    
    // Execute request
    $response = curl_exec($ch);
    $httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    $curlError = curl_error($ch);
    $curlErrno = curl_errno($ch);
    
    // Handle cURL errors with helpful Windows-specific messages
    if ($curlError) {
        $helpMessage = '';
        
        // SSL certificate errors
        if ($curlErrno === 60 || $curlErrno === 77 || strpos($curlError, 'certificate') !== false) {
            $helpMessage = 'SSL Certificate Error. To fix on Windows: ' .
                '1) Download cacert.pem from https://curl.se/ca/cacert.pem ' .
                '2) Save to C:\\php\\extras\\ssl\\cacert.pem ' .
                '3) Add to php.ini: curl.cainfo = "C:\\php\\extras\\ssl\\cacert.pem" ' .
                '4) Restart IIS. ' .
                'Or place cacert.pem in the same folder as this script.';
        }
        
        returnError('Proxy request failed', [
            'curlError' => $curlError,
            'curlErrno' => $curlErrno,
            'help' => $helpMessage,
            'checkedPaths' => [
                'configured' => CACERT_PATH,
                'scriptDir' => dirname(__FILE__) . '/cacert.pem'
            ]
        ]);
    }
    
    // For debugging: if unauthorized, show more details
    if ($httpCode === 401) {
        $jwtParts = explode('.', $jwt);
        $decodedHeader = json_decode(base64_decode(strtr($jwtParts[0], '-_', '+/')), true);
        $decodedPayload = json_decode(base64_decode(strtr($jwtParts[1], '-_', '+/')), true);
        
        http_response_code(401);
        echo json_encode([
            'error' => 'Coinbase returned Unauthorized',
            'httpCode' => $httpCode,
            'coinbaseResponse' => $response,
            'requestUrl' => $url,
            'jwtHeader' => $decodedHeader,
            'jwtPayload' => $decodedPayload,
            'signatureLength' => strlen(base64_decode(strtr($jwtParts[2] . '==', '-_', '+/')))
        ]);
        exit;
    }
    
    // Return the response
    http_response_code($httpCode);
    echo $response;
    
} catch (Throwable $e) {
    returnError('PHP Exception', [
        'message' => $e->getMessage(),
        'file' => basename($e->getFile()),
        'line' => $e->getLine()
    ]);
}


