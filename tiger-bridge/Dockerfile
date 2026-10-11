FROM python:3.12-slim
WORKDIR /bridge
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY app.py .
ENV TIGER_BRIDGE_HOST=0.0.0.0
EXPOSE 8788
CMD ["python", "app.py"]
