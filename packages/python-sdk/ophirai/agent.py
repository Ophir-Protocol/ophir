"""Agent identity helper for registering as a seller."""

from __future__ import annotations

import warnings
from typing import Any, Dict, List, Optional
from urllib.parse import urlparse

import httpx


def _check_tls(url: str, label: str = "URL") -> None:
    parsed = urlparse(url)
    if parsed.scheme == "http" and parsed.hostname not in ("localhost", "127.0.0.1", "::1"):
        warnings.warn(
            f"{label} uses http:// on a non-localhost host. "
            "Use https:// to protect data in transit.",
            stacklevel=3,
        )


class Agent:
    """Represents a local agent identity for registration as a seller.

    This is a convenience wrapper for agents that want to register
    themselves with an Ophir registry.  For authenticated operations
    (registration, heartbeat, deregistration) you will need to provide
    signed challenge headers externally -- this class handles the
    request structure but does not perform Ed25519 signing.

    Parameters
    ----------
    endpoint:
        The public URL where this agent can be reached.
    name:
        Human-readable agent name.  Defaults to the endpoint hostname.
    description:
        Optional human-readable description of this agent.
    """

    def __init__(
        self,
        endpoint: str,
        name: Optional[str] = None,
        description: Optional[str] = None,
        verify_tls: bool = True,
    ) -> None:
        _check_tls(endpoint, "agent endpoint")
        self.endpoint = endpoint.rstrip("/")
        self.name = name or self.endpoint
        self.description = description or ""
        self._verify_tls = verify_tls

    def _build_card(
        self,
        services: Optional[List[Dict[str, Any]]] = None,
        protocols: Optional[List[str]] = None,
        accepted_payments: Optional[List[Dict[str, str]]] = None,
        negotiation_styles: Optional[List[str]] = None,
        max_rounds: Optional[int] = None,
    ) -> Dict[str, Any]:
        """Build an Agent Card body for registration."""
        card: Dict[str, Any] = {
            "name": self.name,
            "url": self.endpoint,
        }
        if self.description:
            card["description"] = self.description

        negotiation: Dict[str, Any] = {
            "supported": True,
            "endpoint": f"{self.endpoint}/ophir/negotiate",
            "protocols": protocols or ["ophir/1.0"],
        }
        if accepted_payments:
            negotiation["acceptedPayments"] = accepted_payments
        if negotiation_styles:
            negotiation["negotiationStyles"] = negotiation_styles
        if max_rounds is not None:
            negotiation["maxNegotiationRounds"] = max_rounds
        if services:
            negotiation["services"] = services

        card["capabilities"] = {"negotiation": negotiation}
        return card

    def register(
        self,
        registry_url: str = "https://registry.ophirai.com",
        services: Optional[List[Dict[str, Any]]] = None,
        agent_id: Optional[str] = None,
        signature: Optional[str] = None,
        protocols: Optional[List[str]] = None,
        accepted_payments: Optional[List[Dict[str, str]]] = None,
        negotiation_styles: Optional[List[str]] = None,
        max_rounds: Optional[int] = None,
        timeout: float = 30.0,
    ) -> dict:
        """Register this agent with an Ophir registry.

        Parameters
        ----------
        registry_url:
            Base URL of the registry.
        services:
            List of service dicts, each with ``category``, ``description``,
            ``base_price``, ``currency``, and ``unit`` keys.
        agent_id:
            The agent's ``did:key`` URI for authenticated registration.
        signature:
            Base64-encoded Ed25519 signature of an active challenge.
        protocols:
            Supported protocol versions.  Defaults to ``["ophir/1.0"]``.
        accepted_payments:
            Payment methods (list of dicts with ``network`` and ``token``).
        negotiation_styles:
            Supported pricing strategies (e.g. ``["fixed"]``).
        max_rounds:
            Maximum negotiation counter-offer rounds.
        timeout:
            Request timeout in seconds.

        Returns
        -------
        dict
            The registration response from the registry.
        """
        _check_tls(registry_url, "registry_url")
        card = self._build_card(
            services=services,
            protocols=protocols,
            accepted_payments=accepted_payments,
            negotiation_styles=negotiation_styles,
            max_rounds=max_rounds,
        )

        headers: Dict[str, str] = {"Content-Type": "application/json"}
        if agent_id:
            headers["X-Agent-Id"] = agent_id
        if signature:
            headers["X-Agent-Signature"] = signature

        registry_url = registry_url.rstrip("/")
        with httpx.Client(timeout=timeout) as client:
            resp = client.post(
                f"{registry_url}/agents",
                headers=headers,
                json=card,
            )
            resp.raise_for_status()
            return resp.json()

    async def aregister(
        self,
        registry_url: str = "https://registry.ophirai.com",
        services: Optional[List[Dict[str, Any]]] = None,
        agent_id: Optional[str] = None,
        signature: Optional[str] = None,
        protocols: Optional[List[str]] = None,
        accepted_payments: Optional[List[Dict[str, str]]] = None,
        negotiation_styles: Optional[List[str]] = None,
        max_rounds: Optional[int] = None,
        timeout: float = 30.0,
    ) -> dict:
        """Async version of :meth:`register`."""
        _check_tls(registry_url, "registry_url")
        card = self._build_card(
            services=services,
            protocols=protocols,
            accepted_payments=accepted_payments,
            negotiation_styles=negotiation_styles,
            max_rounds=max_rounds,
        )

        headers: Dict[str, str] = {"Content-Type": "application/json"}
        if agent_id:
            headers["X-Agent-Id"] = agent_id
        if signature:
            headers["X-Agent-Signature"] = signature

        registry_url = registry_url.rstrip("/")
        async with httpx.AsyncClient(timeout=timeout) as client:
            resp = await client.post(
                f"{registry_url}/agents",
                headers=headers,
                json=card,
            )
            resp.raise_for_status()
            return resp.json()
