# Data pipeline image. Used by the "pipeline" compose profile:
#   docker compose run --rm pipeline
# The full python image (not -slim) already has curl and the system libraries
# that the rasterio/GDAL wheels need.
FROM python:3.13
COPY pipeline/requirements.txt /tmp/requirements.txt
RUN pip install --no-cache-dir -r /tmp/requirements.txt
WORKDIR /work
CMD ["bash", "-c", "pipeline/download.sh && python pipeline/build.py"]
