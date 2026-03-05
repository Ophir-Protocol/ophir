"""Ophir gateway client -- OpenAI-compatible chat completions."""

from __future__ import annotations

from typing import Any, Dict, List, Optional

import httpx


class Client:
    """Thin wrapper around the Ophir inference gateway.

    The gateway speaks the OpenAI ``/v1/chat/completions`` format, so this
    client can be used as a drop-in replacement for the OpenAI SDK when you
    only need chat completions and model listing.

    Parameters
    ----------
    gateway_url:
        Base URL of the Ophir gateway.  Defaults to the hosted gateway.
    api_key:
        Optional API key.  The public gateway does not require one, but
        private deployments may.
    timeout:
        Request timeout in seconds.
    """

    def __init__(
        self,
        gateway_url: str = "https://api.ophirai.com",
        api_key: Optional[str] = None,
        timeout: float = 60.0,
    ) -> None:
        self.gateway_url = gateway_url.rstrip("/")
        self.api_key = api_key
        self._timeout = timeout

    # -- internal helpers ------------------------------------------------

    def _headers(self) -> Dict[str, str]:
        headers: Dict[str, str] = {"Content-Type": "application/json"}
        if self.api_key:
            headers["Authorization"] = f"Bearer {self.api_key}"
        return headers

    def _client(self) -> httpx.Client:
        return httpx.Client(timeout=self._timeout)

    async def _async_client(self) -> httpx.AsyncClient:
        return httpx.AsyncClient(timeout=self._timeout)

    # -- sync API --------------------------------------------------------

    def chat(
        self,
        model: str,
        messages: List[Dict[str, str]],
        temperature: float = 0.7,
        max_tokens: Optional[int] = None,
        **kwargs: Any,
    ) -> dict:
        """Send a chat completion request through the Ophir gateway.

        Parameters
        ----------
        model:
            Model name.  Use ``"auto"`` to let the gateway pick via
            negotiation.
        messages:
            List of message dicts with ``role`` and ``content`` keys.
        temperature:
            Sampling temperature.
        max_tokens:
            Maximum tokens to generate.
        **kwargs:
            Additional parameters forwarded to the API body.
        """
        body: Dict[str, Any] = {
            "model": model,
            "messages": messages,
            "temperature": temperature,
            **kwargs,
        }
        if max_tokens is not None:
            body["max_tokens"] = max_tokens

        with self._client() as client:
            resp = client.post(
                f"{self.gateway_url}/v1/chat/completions",
                headers=self._headers(),
                json=body,
            )
            resp.raise_for_status()
            return resp.json()

    def list_models(self) -> list:
        """List models available through the gateway."""
        with self._client() as client:
            resp = client.get(
                f"{self.gateway_url}/v1/models",
                headers=self._headers(),
            )
            resp.raise_for_status()
            data = resp.json()
            return data.get("data", data)

    def health(self) -> dict:
        """Check gateway health."""
        with self._client() as client:
            resp = client.get(f"{self.gateway_url}/health")
            resp.raise_for_status()
            return resp.json()

    # -- async API -------------------------------------------------------

    async def achat(
        self,
        model: str,
        messages: List[Dict[str, str]],
        temperature: float = 0.7,
        max_tokens: Optional[int] = None,
        **kwargs: Any,
    ) -> dict:
        """Async version of :meth:`chat`."""
        body: Dict[str, Any] = {
            "model": model,
            "messages": messages,
            "temperature": temperature,
            **kwargs,
        }
        if max_tokens is not None:
            body["max_tokens"] = max_tokens

        async with httpx.AsyncClient(timeout=self._timeout) as client:
            resp = await client.post(
                f"{self.gateway_url}/v1/chat/completions",
                headers=self._headers(),
                json=body,
            )
            resp.raise_for_status()
            return resp.json()

    async def alist_models(self) -> list:
        """Async version of :meth:`list_models`."""
        async with httpx.AsyncClient(timeout=self._timeout) as client:
            resp = await client.get(
                f"{self.gateway_url}/v1/models",
                headers=self._headers(),
            )
            resp.raise_for_status()
            data = resp.json()
            return data.get("data", data)

    async def ahealth(self) -> dict:
        """Async version of :meth:`health`."""
        async with httpx.AsyncClient(timeout=self._timeout) as client:
            resp = await client.get(f"{self.gateway_url}/health")
            resp.raise_for_status()
            return resp.json()
