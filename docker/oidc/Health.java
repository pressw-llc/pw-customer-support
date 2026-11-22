import java.net.HttpURLConnection;
import java.net.URI;

public class Health {
  public static void main(String[] args) throws Exception {
    HttpURLConnection connection =
        (HttpURLConnection) URI.create(args[0]).toURL().openConnection();
    connection.setConnectTimeout(2000);
    connection.setReadTimeout(2000);
    System.exit(connection.getResponseCode() == 200 ? 0 : 1);
  }
}
