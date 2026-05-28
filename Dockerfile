FROM python:3.13-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /app

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY titantv_grabber.py ./

RUN set -eux; \
    groupadd --system titantv; \
    useradd --system --gid titantv --home-dir /app --shell /usr/sbin/nologin titantv; \
    mkdir -p /data; \
    chown -R titantv:titantv /app /data

USER titantv
WORKDIR /data
VOLUME ["/data"]
ENTRYPOINT ["python", "/app/titantv_grabber.py"]
