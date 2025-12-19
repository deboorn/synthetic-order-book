<?php
/**
 * Coinbase Advanced Trade API Proxy
 * 
 * Forwards requests to Coinbase API to avoid CORS issues.
 * Generates JWT server-side using PHP's OpenSSL for EC key support.
 * 
 * Based on official Coinbase PHP example:
 * https://docs.cdp.coinbase.com/coinbase-app/authentication-authorization/api-key-authentication#php
 * 
 * @copyright 2025 Daniel Boorn <daniel.boorn@gmail.com>
 * @license Personal use only. Not for commercial reproduction.
 */

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
        'openssl_version' => OPENSSL_VERSION_TEXT
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
 * This is critical for JWT - OpenSSL returns DER, but JWT needs raw format
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
    // Remove leading zeros if present (DER integers are signed)
    $r = ltrim($r, "\x00");
    $s = ltrim($s, "\x00");
    
    // Pad to exactly 32 bytes
    $r = str_pad($r, 32, "\x00", STR_PAD_LEFT);
    $s = str_pad($s, 32, "\x00", STR_PAD_LEFT);
    
    return $r . $s;
}

/**
 * Generate JWT for Coinbase API
 * Based on official Coinbase example
 * 
 * @param string $keyName API key name
 * @param string $keySecret Private key PEM
 * @param string $requestMethod HTTP method (GET, POST, etc.) or empty for WebSocket
 * @param string $requestPath API path or empty for WebSocket
 * @return string JWT token
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

// Wrap everything in try-catch
try {
    // Get request parameters
    $action = $_POST['action'] ?? 'proxy'; // 'proxy' (default) or 'jwt'
    $endpoint = $_POST['endpoint'] ?? '';
    $method = strtoupper($_POST['method'] ?? 'GET');
    $body = $_POST['body'] ?? '';
    $apiKey = $_POST['apiKey'] ?? '';
    $privateKey = $_POST['privateKey'] ?? '';
    
    // Validate credentials for all actions
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
    
    // Action: proxy (default) - Forward request to Coinbase API
    if (empty($endpoint)) {
        returnError('Missing endpoint parameter', [], 400);
    }
    
    // Strip query params for JWT URI (keep full endpoint for actual request)
    $pathForJwt = explode('?', $endpoint)[0];
    
    // Generate JWT
    $jwt = generateJWT($apiKey, $privateKey, $method, $pathForJwt);
    
    // Coinbase production API
    $baseUrl = 'https://api.coinbase.com';
    $url = $baseUrl . $endpoint;
    
    // Initialize cURL
    $ch = curl_init();
    
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
    curl_close($ch);
    
    // Handle cURL errors
    if ($curlError) {
        returnError('Proxy request failed', ['curlError' => $curlError]);
    }
    
    // For debugging: if unauthorized, show more details
    if ($httpCode === 401) {
        // Decode JWT to show what was sent
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
    
    // Return the response with the same HTTP code
    http_response_code($httpCode);
    echo $response;
    
} catch (Throwable $e) {
    returnError('PHP Exception', [
        'message' => $e->getMessage(),
        'file' => basename($e->getFile()),
        'line' => $e->getLine()
    ]);
}
