"""Client for the Ophir agent registry."""

from __future__ import annotations

from typing import Any, Dict, List, Optional

import httpx


class Registry:
    """Read-only client for discovering agents on an Ophir registry.

    Parameters
    ----------
    url:
        Base URL of the registry.
    timeout:
        Request timeout in seconds.
    """

    def __init__(
        self,
        url: str = "https://registry.ophirai.com",
        timeout: float = 30.0,
    ) -> None:
        self.url = url.rstrip("/")
        self._timeout = timeout

    def _client(self) -> httpx.Client:
        return httpx.Client(timeout=self._timeout)

    # -- sync API --------------------------------------------------------

    def list_agents(
        self,
        category: Optional[str] = None,
        max_price: Optional[str] = None,
        currency: Optional[str] = None,
        min_reputation: Optional[int] = None,
        limit: Optional[int] = None,
    ) -> list:
        """List registered agents, optionally filtered.

        Parameters
        ----------
        category:
            Filter by service category (e.g. ``"inference"``).
        max_price:
            Maximum base price as a decimal string.
        currency:
            Filter by payment currency (e.g. ``"USDC"``).
        min_reputation:
            Minimum reputation score (0--100).
        limit:
            Maximum number of results.
        """
        params: Dict[str, Any] = {}
        if category is not None:
            params["category"] = category
        if max_price is not None:
            params["max_price"] = max_price
        if currency is not None:
            params["currency"] = currency
        if min_reputation is not None:
            params["min_reputation"] = min_reputation
        if limit is not None:
            params["limit"] = limit

        with self._client() as client:
            resp = client.get(f"{self.url}/agents", params=params)
            resp.raise_for_status()
            data = resp.json()
            # The registry wraps results in {"success": true, "data": {"agents": [...]}}
            if isinstance(data, dict) and "data" in data:
                inner = data["data"]
                if isinstance(inner, dict) and "agents" in inner:
                    return inner["agents"]
                return inner
            return data

    def get_agent(self, agent_id: str) -> dict:
        """Get details for a single agent.

        Parameters
        ----------
        agent_id:
            The agent's ``did:key`` identifier.
        """
        with self._client() as client:
            resp = client.get(f"{self.url}/agents/{agent_id}")
            resp.raise_for_status()
            data = resp.json()
            if isinstance(data, dict) and "data" in data:
                return data["data"]
            return data

    def search(self, query: str) -> list:
        """Search for agents by keyword.

        Parameters
        ----------
        query:
            Free-text search query.
        """
        with self._client() as client:
            resp = client.get(
                f"{self.url}/agents/search",
                params={"q": query},
            )
            resp.raise_for_status()
            data = resp.json()
            if isinstance(data, dict) and "data" in data:
                inner = data["data"]
                if isinstance(inner, dict) and "agents" in inner:
                    return inner["agents"]
                return inner
            return data

    def health(self) -> dict:
        """Check registry health."""
        with self._client() as client:
            resp = client.get(f"{self.url}/health")
            resp.raise_for_status()
            return resp.json()

    def challenge(self, agent_id: str) -> dict:
        """Request an authentication challenge for the given agent.

        Returns a dict with ``challenge`` and ``expires_in`` fields.
        """
        with self._client() as client:
            resp = client.post(
                f"{self.url}/auth/challenge",
                json={"agent_id": agent_id},
            )
            resp.raise_for_status()
            return resp.json()

    # -- async API -------------------------------------------------------

    async def alist_agents(
        self,
        category: Optional[str] = None,
        max_price: Optional[str] = None,
        currency: Optional[str] = None,
        min_reputation: Optional[int] = None,
        limit: Optional[int] = None,
    ) -> list:
        """Async version of :meth:`list_agents`."""
        params: Dict[str, Any] = {}
        if category is not None:
            params["category"] = category
        if max_price is not None:
            params["max_price"] = max_price
        if currency is not None:
            params["currency"] = currency
        if min_reputation is not None:
            params["min_reputation"] = min_reputation
        if limit is not None:
            params["limit"] = limit

        async with httpx.AsyncClient(timeout=self._timeout) as client:
            resp = await client.get(f"{self.url}/agents", params=params)
            resp.raise_for_status()
            data = resp.json()
            if isinstance(data, dict) and "data" in data:
                inner = data["data"]
                if isinstance(inner, dict) and "agents" in inner:
                    return inner["agents"]
                return inner
            return data

    async def aget_agent(self, agent_id: str) -> dict:
        """Async version of :meth:`get_agent`."""
        async with httpx.AsyncClient(timeout=self._timeout) as client:
            resp = await client.get(f"{self.url}/agents/{agent_id}")
            resp.raise_for_status()
            data = resp.json()
            if isinstance(data, dict) and "data" in data:
                return data["data"]
            return data

    async def asearch(self, query: str) -> list:
        """Async version of :meth:`search`."""
        async with httpx.AsyncClient(timeout=self._timeout) as client:
            resp = await client.get(
                f"{self.url}/agents/search",
                params={"q": query},
            )
            resp.raise_for_status()
            data = resp.json()
            if isinstance(data, dict) and "data" in data:
                inner = data["data"]
                if isinstance(inner, dict) and "agents" in inner:
                    return inner["agents"]
                return inner
            return data
