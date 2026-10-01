# =====================================================================
# Image Spring Boot pour la plateforme Kubernetes.
# Différences avec modeles/depot/Dockerfile.exemple (infra) :
#  - un UID NUMÉRIQUE (10001) : Kubernetes vérifie runAsNonRoot sur un nombre ;
#  - rien n'est écrit hors de /tmp (la racine est montée en lecture seule) ;
#  - le port et l'adresse viennent du chart (variablePort / variableAdresse).
# =====================================================================
FROM eclipse-temurin:21-jdk AS construction
WORKDIR /source
COPY . ./
RUN chmod +x gradlew && ./gradlew bootJar --no-daemon --console=plain -x test \
    && cp build/libs/*.jar /app.jar

FROM eclipse-temurin:21-jre
ENV LANG=C.UTF-8 TZ=Africa/Casablanca
RUN groupadd --system --gid 10001 app \
    && useradd --system --uid 10001 --gid app --home-dir /opt/app --shell /usr/sbin/nologin app
WORKDIR /opt/app
COPY --from=construction --chown=root:root --chmod=0444 /app.jar app.jar
USER 10001:10001
EXPOSE 8080
# La mémoire : JAVA_TOOL_OPTIONS (-XX:MaxRAMPercentage) est posé par le chart.
ENTRYPOINT ["java", "-jar", "/opt/app/app.jar"]
