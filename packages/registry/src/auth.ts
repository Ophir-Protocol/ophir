import type { Request, Response, NextFunction, RequestHandler } from 'express';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import type { RegistryDB } from './db.js';

const DID_KEY_PREFIX = 'did:key:z';
const ED25519_MULTICODEC_PREFIX = new Uint8Array([0xed, 0x01]);

declare global {
  namespace Express {
    interface Request {
      agentId?: string;
    }
  }
}

export interface AuthMiddleware {
  /** Express middleware that verifies X-Agent-Id and X-Agent-Signature headers. */
  requireAuth: RequestHandler;
  /** Route handler for POST /auth/challenge. */
  challengeHandler: RequestHandler;
}

/** Extract the raw 32-byte Ed25519 public key from a did:key:z... string. */
function didToPublicKey(did: string): Uint8Array {
  if (!did || !did.startsWith(DID_KEY_PREFIX)) {
    throw new Error(`Invalid did:key format: ${did}`);
  }
  const encoded = did.slice(DID_KEY_PREFIX.length);
  const decoded = bs58.decode(encoded);
  if (
    decoded.length < 2 ||
    decoded[0] !== ED25519_MULTICODEC_PREFIX[0] ||
    decoded[1] !== ED25519_MULTICODEC_PREFIX[1]
  ) {
    throw new Error('Invalid multicodec prefix — expected Ed25519 (0xed01)');
  }
  const publicKey = decoded.slice(2);
  if (publicKey.length !== 32) {
    throw new Error(`Invalid public key length: expected 32, got ${publicKey.length}`);
  }
  return publicKey;
}

export function createAuthMiddleware(db: RegistryDB): AuthMiddleware {
  const requireAuth: RequestHandler = (req: Request, res: Response, next: NextFunction): void => {
    const agentId = req.headers['x-agent-id'] as string | undefined;
    const signatureHeader = req.headers['x-agent-signature'] as string | undefined;

    if (!agentId || !signatureHeader) {
      res.status(401).json({ error: 'Missing authentication headers' });
      return;
    }

    let publicKey: Uint8Array;
    try {
      publicKey = didToPublicKey(agentId);
    } catch {
      res.status(401).json({ error: 'Invalid agent ID format' });
      return;
    }

    const signature = Buffer.from(signatureHeader, 'base64');
    if (signature.length !== 64) {
      res.status(403).json({ error: 'Invalid signature' });
      return;
    }

    const challenges = db.getActiveChallenges(agentId);
    let matchedChallenge: string | undefined;
    for (const challenge of challenges) {
      const message = new TextEncoder().encode(challenge);
      if (nacl.sign.detached.verify(message, new Uint8Array(signature), publicKey)) {
        matchedChallenge = challenge;
        break;
      }
    }

    if (!matchedChallenge) {
      res.status(403).json({ error: 'Invalid signature' });
      return;
    }

    // Consume the challenge so it cannot be replayed
    db.verifyChallenge(agentId, matchedChallenge);

    req.agentId = agentId;
    next();
  };

  const challengeHandler: RequestHandler = (req: Request, res: Response): void => {
    const { agent_id } = req.body as { agent_id?: string };

    if (!agent_id || !agent_id.startsWith(DID_KEY_PREFIX)) {
      res.status(400).json({ error: 'Invalid or missing agent_id' });
      return;
    }

    try {
      didToPublicKey(agent_id);
    } catch {
      res.status(400).json({ error: 'Invalid agent_id format' });
      return;
    }

    const challenge = db.createChallenge(agent_id);
    res.json({ challenge, expires_in: 300 });
  };

  return { requireAuth, challengeHandler };
}
